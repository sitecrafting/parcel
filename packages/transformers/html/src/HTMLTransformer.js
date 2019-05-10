// @flow

import {Transformer} from '@parcel/plugin';

import parse from 'posthtml-parser';
import render from 'posthtml-render';
import nullthrows from 'nullthrows';
import collectDependencies from './dependencies';
import extractInlineAssets from './inline';

export default new Transformer({
  canReuseAST(ast) {
    return ast.type === 'posthtml' && ast.version === '0.0.0';
  },

  async parse(asset) {
    return {
      type: 'posthtml',
      version: '0.0.0',
      program: parse(await asset.getCode(), {
        lowerCaseAttributeNames: true
      })
    };
  },

  async transform(asset) {
    // Handle .htm
    asset.type = 'html';
    collectDependencies(asset);
    return [asset, ...extractInlineAssets(asset)];
  },

  generate(asset) {
    return {
      code: render(nullthrows(asset.ast).program)
    };
  }
});
