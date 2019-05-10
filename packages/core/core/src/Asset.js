// @flow strict-local

import {Readable} from 'stream';

import type {
  AST,
  Blob,
  Config,
  Dependency as IDependency,
  DependencyOptions,
  Environment,
  File,
  FilePath,
  Meta,
  PackageJSON,
  SourceMap,
  Stats,
  TransformerResult
} from '@parcel/types';

import crypto from 'crypto';
import {
  bufferStream,
  loadConfig,
  md5FromFilePath,
  md5FromString,
  readableFromStringOrBuffer,
  TapStream
} from '@parcel/utils';
import Cache from '@parcel/cache';
import nullthrows from 'nullthrows';
import Dependency from './Dependency';

type AssetOptions = {|
  id?: string,
  hash?: ?string,
  filePath: FilePath,
  type: string,
  content?: Blob,
  contentKey?: ?string,
  ast?: ?AST,
  map?: ?SourceMap,
  mapKey?: ?string,
  dependencies?: Iterable<[string, IDependency]>,
  connectedFiles?: Iterable<[FilePath, File]>,
  isIsolated?: boolean,
  outputHash?: string,
  env: Environment,
  meta?: Meta,
  stats: Stats
|};

type SerializedOptions = {|
  ...AssetOptions,
  ...{|
    connectedFiles: Array<[FilePath, File]>,
    dependencies: Array<[string, IDependency]>
  |}
|};

export default class Asset {
  id: string;
  hash: ?string;
  filePath: FilePath;
  type: string;
  ast: ?AST;
  map: ?SourceMap;
  mapKey: ?string;
  dependencies: Map<string, IDependency>;
  connectedFiles: Map<FilePath, File>;
  isIsolated: boolean;
  depToBundlePath: ?Map<string, FilePath>;
  outputHash: string;
  env: Environment;
  meta: Meta;
  stats: Stats;
  content: Blob;
  contentKey: ?string;

  constructor(options: AssetOptions) {
    this.id =
      options.id != null
        ? options.id
        : md5FromString(
            options.filePath + options.type + JSON.stringify(options.env)
          );
    this.hash = options.hash;
    this.filePath = options.filePath;
    this.isIsolated = options.isIsolated == null ? false : options.isIsolated;
    this.type = options.type;
    this.content = options.content || '';
    this.contentKey = options.contentKey;
    this.ast = options.ast || null;
    this.map = options.map;
    this.dependencies = options.dependencies
      ? new Map(options.dependencies)
      : new Map();
    this.connectedFiles = options.connectedFiles
      ? new Map(options.connectedFiles)
      : new Map();
    this.outputHash = options.outputHash || '';
    this.env = options.env;
    this.meta = options.meta || {};
    this.stats = options.stats;
  }

  serialize(): SerializedOptions {
    // Exclude `code`, `map`, and `ast` from cache
    return {
      id: this.id,
      hash: this.hash,
      filePath: this.filePath,
      type: this.type,
      dependencies: Array.from(this.dependencies),
      connectedFiles: Array.from(this.connectedFiles),
      isIsolated: this.isIsolated,
      outputHash: this.outputHash,
      env: this.env,
      meta: this.meta,
      stats: this.stats,
      contentKey: this.contentKey
    };
  }

  /*
   * Prepares the asset for being serialized to the cache by commiting its
   * content and map of the asset to the cache.
   */
  async commit(): Promise<void> {
    this.ast = null;

    let contentStream = this.getStream();
    if (
      // $FlowFixMe
      typeof contentStream.bytesRead === 'number' &&
      contentStream.bytesRead > 0
    ) {
      throw new Error(
        'Stream has already been read. This may happen if a plugin reads from a stream and does not replace it.'
      );
    }

    let size = 0;
    let hash = crypto.createHash('md5');

    // Since we can only read from the stream once, compute the content length
    // and hash while it's being written to the cache.
    let [contentKey, mapKey] = await Promise.all([
      Cache.setStream(
        this.generateCacheKey('content'),
        contentStream.pipe(
          new TapStream(buf => {
            size += buf.length;
            hash.update(buf);
          })
        )
      ),
      this.map == null
        ? Promise.resolve()
        : Cache.set(this.generateCacheKey('map'), this.map)
    ]);
    this.contentKey = contentKey;
    this.mapKey = mapKey;
    this.stats.size = size;
    this.outputHash = hash.digest('hex');
  }

  async getCode(): Promise<string> {
    if (this.contentKey != null) {
      this.content = Cache.getStream(this.contentKey);
    }

    if (typeof this.content === 'string' || this.content instanceof Buffer) {
      this.content = this.content.toString();
    } else {
      this.content = (await bufferStream(this.content)).toString();
    }

    let content = this.content;
    let depToBundlePath = this.depToBundlePath;
    if (depToBundlePath != null) {
      // If a dependency-to-bundle-path mapping is set, replace
      // references to dependencies with their proper bundle urls
      this.content = replaceReferences(
        content,
        this.getDependencies(),
        depToBundlePath
      );
    }

    return this.content;
  }

  async getBuffer(): Promise<Buffer> {
    if (this.contentKey != null) {
      this.content = Cache.getStream(this.contentKey);
    }

    if (typeof this.content === 'string' || this.content instanceof Buffer) {
      return Buffer.from(this.content);
    }

    this.content = await bufferStream(this.content);
    return this.content;
  }

  getStream(): Readable {
    if (this.contentKey != null) {
      this.content = Cache.getStream(this.contentKey);
    }

    if (this.content instanceof Readable) {
      return this.content;
    }

    return readableFromStringOrBuffer(this.content);
  }

  setCode(code: string) {
    this.content = code;
  }

  setBuffer(buffer: Buffer) {
    this.content = buffer;
  }

  setStream(stream: Readable) {
    this.content = stream;
  }

  async getMap(): Promise<?SourceMap> {
    if (this.mapKey != null) {
      this.map = await Cache.get(this.mapKey);
    }

    return this.map;
  }

  setMap(map: ?SourceMap): void {
    this.map = map;
  }

  generateCacheKey(key: string): string {
    return md5FromString(key + this.id + JSON.stringify(this.env));
  }

  addDependency(opts: DependencyOptions) {
    let {env, ...rest} = opts;
    let dep = new Dependency({
      ...rest,
      env: this.env.merge(env),
      sourcePath: this.filePath
    });

    this.dependencies.set(dep.id, dep);
    return dep.id;
  }

  async addConnectedFile(file: File) {
    if (file.hash == null) {
      file.hash = await md5FromFilePath(file.filePath);
    }

    this.connectedFiles.set(file.filePath, file);
  }

  getConnectedFiles(): Array<File> {
    return Array.from(this.connectedFiles.values());
  }

  getDependencies(): Array<IDependency> {
    return Array.from(this.dependencies.values());
  }

  createChildAsset(result: TransformerResult): Asset {
    let content;
    if (result.content != null) {
      content = result.content;
    } else if (result.code != null) {
      content = result.code;
    } else {
      content = '';
    }

    let hash;
    let size;
    if (content === this.content) {
      hash = this.hash;
      size = this.stats.size;
    } else if (typeof content === 'string' || content instanceof Buffer) {
      hash = md5FromString(content);
      size = content.length;
    } else {
      hash = null;
      size = NaN;
    }

    let asset = new Asset({
      hash,
      filePath: this.filePath,
      type: result.type,
      content,
      ast: result.ast,
      isIsolated: result.isIsolated,
      env: this.env.merge(result.env),
      dependencies: this.dependencies,
      connectedFiles: this.connectedFiles,
      meta: {...this.meta, ...result.meta},
      stats: {
        time: 0,
        size
      }
    });

    let dependencies = result.dependencies;
    if (dependencies) {
      for (let dep of dependencies) {
        asset.addDependency(dep);
      }
    }

    let connectedFiles = result.connectedFiles;
    if (connectedFiles) {
      for (let file of connectedFiles) {
        asset.addConnectedFile(file);
      }
    }

    return asset;
  }

  async getConfig(
    filePaths: Array<FilePath>,
    options: ?{packageKey?: string, parse?: boolean}
  ): Promise<Config | null> {
    let packageKey = options && options.packageKey;
    let parse = options && options.parse;

    if (packageKey != null) {
      let pkg = await this.getPackage();
      if (pkg && pkg[packageKey]) {
        return pkg[packageKey];
      }
    }

    let conf = await loadConfig(
      this.filePath,
      filePaths,
      parse == null ? null : {parse}
    );
    if (!conf) {
      return null;
    }

    for (let file of conf.files) {
      this.addConnectedFile(file);
    }

    return conf.config;
  }

  async getPackage(): Promise<PackageJSON | null> {
    return this.getConfig(['package.json']);
  }
}

function replaceReferences(
  code: string,
  dependencies: Array<IDependency>,
  depToBundlePath: Map<string, FilePath>
): string {
  let output = code;
  // replace references to url dependencies with relative paths to their
  // corresponding bundles.
  // TODO: This likely alters the length of the column in the source text.
  //       Update any sourcemaps accordingly.
  for (let dep of dependencies) {
    if (!dep.isURL) {
      continue;
    }

    let split = output.split(dep.id);
    if (split.length > 1) {
      // the dependency id was found in the text. replace it.
      let replacement = nullthrows(
        depToBundlePath.get(dep.id),
        'replacement text not found for a dependency placeholder'
      );
      output = split.join(replacement);
    }
  }

  return output;
}
