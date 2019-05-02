// @flow

import type {ParcelOptions, Stats} from '@parcel/types';
import type {Bundle} from './types';
import type InternalBundleGraph from './BundleGraph';

import AssetGraph from './AssetGraph';
import {BundleGraph} from './public/BundleGraph';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import TargetResolver from './TargetResolver';
import getRootDir from '@parcel/utils/src/getRootDir';
import loadEnv from './loadEnv';
import loadParcelConfig from './loadParcelConfig';
import path from 'path';
import Cache from '@parcel/cache';
import Watcher from '@parcel/watcher';
import AssetGraphBuilder, {BuildAbortError} from './AssetGraphBuilder';
import ReporterRunner from './ReporterRunner';
import MainAssetGraph from './public/MainAssetGraph';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import {
  AbortController,
  type AbortSignal
} from 'abortcontroller-polyfill/dist/cjs-ponyfill';

export default class Parcel {
  options: ParcelOptions;
  entries: Array<string>;
  rootDir: string;
  assetGraphBuilder: AssetGraphBuilder;
  bundlerRunner: BundlerRunner;
  reporterRunner: ReporterRunner;
  farm: WorkerFarm;
  runPackage: (bundle: Bundle) => Promise<Stats>;

  constructor(options: ParcelOptions) {
    this.options = options;
    // TODO: Get projectRoot and lockFile programmatically
    this.options.projectRoot = process.cwd();
    this.options.cwd = process.cwd();
    this.options.lockFilePath = `${this.options.projectRoot}/yarn.lock`;
    this.entries = Array.isArray(options.entries)
      ? options.entries
      : options.entries
        ? [options.entries]
        : [];
    this.rootDir = getRootDir(this.entries);
  }

  async init(): Promise<void> {
    await Cache.createCacheDir(this.options.cacheDir);

    if (!this.options.env) {
      await loadEnv(path.join(this.rootDir, 'index'));
      this.options.env = process.env;
    }

    // ? What to use for filePath
    let config = await loadParcelConfig(this.options.cwd, this.options);

    this.farm = await WorkerFarm.getShared(
      {
        config,
        options: this.options,
        env: this.options.env
      },
      {
        workerPath: require.resolve('./worker')
      }
    );

    this.bundlerRunner = new BundlerRunner({
      config,
      options: this.options,
      rootDir: this.rootDir
    });

    let targetResolver = new TargetResolver();
    let targets = await targetResolver.resolve(this.rootDir);

    this.reporterRunner = new ReporterRunner({
      targets,
      config,
      options: this.options
    });

    this.assetGraphBuilder = new AssetGraphBuilder({
      options: this.options,
      entries: this.entries,
      targets,
      rootDir: this.rootDir
    });

    this.runPackage = this.farm.mkhandle('runPackage');
  }

  async run(): Promise<InternalBundleGraph> {
    await this.init();

    if (this.options.watch) {
      this.watcher = new Watcher();
      this.watcher.watch(this.options.projectRoot);
      this.watcher.on('all', (event, path) => {
        if (path.includes('.parcel-cache')) return; // TODO: unwatch from watcher, couldn't get it working
        // TODO: filter out dist changes
        console.log('DETECTED CHANGE', event, path);
        this.assetGraphBuilder.respondToFSChange({
          action: event,
          path
        });
        if (this.assetGraphBuilder.isInvalid()) {
          console.log('ASSET GRAPH IS INVALID');
          this.controller.abort();
          this.build();
        }
      });
    }

    return this.build();
  }

  async build(): Promise<InternalBundleGraph> {
    try {
      this.reporterRunner.report({
        type: 'buildStart'
      });

      let startTime = Date.now();
      // console.log('Starting build'); // eslint-disable-line no-console
      this.controller = new AbortController();
      let signal = this.controller.signal;

      let assetGraph = await this.assetGraphBuilder.build({signal});
      console.log('DONE BUILDING ASSET GRAPH');
      dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');

      let bundleGraph = await this.bundle(assetGraph);
      console.log('BUNDLE GRAPH', prettyFormat(bundleGraph));
      dumpGraphToGraphViz(bundleGraph, 'BundleGraph');

      await this.package(bundleGraph);

      this.reporterRunner.report({
        type: 'buildSuccess',
        changedAssets: new Map(this.assetGraphBuilder.changedAssets),
        assetGraph: new MainAssetGraph(assetGraph),
        bundleGraph: new BundleGraph(bundleGraph),
        buildTime: Date.now() - startTime
      });

      if (!this.options.watch && this.options.killWorkers !== false) {
        await this.farm.end();
      }

      return bundleGraph;
    } catch (e) {
      if (!(e instanceof BuildAbortError)) {
        this.reporterRunner.report({
          type: 'buildFailure',
          error: e
        });
      }
      throw e;
    }
  }

  bundle(assetGraph: AssetGraph): Promise<InternalBundleGraph> {
    return this.bundlerRunner.bundle(assetGraph);
  }

  package(bundleGraph: InternalBundleGraph): Promise<mixed> {
    let promises = [];
    bundleGraph.traverseBundles(bundle => {
      promises.push(
        this.runPackage(bundle).then(stats => {
          bundle.stats = stats;
        })
      );
    });

    return Promise.all(promises);
  }
}

export {default as Asset} from './Asset';
export {default as Dependency} from './Dependency';
export {default as Environment} from './Environment';
