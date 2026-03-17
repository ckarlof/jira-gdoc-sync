'use strict';

/**
 * Loads Code.gs into a sandboxed VM context with all Apps Script globals stubbed
 * out, then returns the pure functions for testing.
 *
 * Functions that depend only on JavaScript (no Apps Script services) are fully
 * exercisable: adfToBlocks, autoLinkSegments, buildCommentDigest.
 */

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal CONFIG stub — tests can override individual fields as needed.
const CONFIG_STUB = {
  jira:       { baseUrl: 'https://example.atlassian.net' },
  objectives: [],
  krSortOrder: 'jira',
  style: {
    headerBgColor:   '#073763',
    headerTextColor: '#FFFFFF',
    colWidths:       [175, 75, 600]
  },
  aiSummary: { enabled: false, model: 'claude-opus-4-6', prompt: '' }
};

// Stubs for Apps Script globals that appear in Code.gs but are never called
// by the pure functions under test.
const APPS_SCRIPT_STUBS = {
  PropertiesService: { getUserProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
  UrlFetchApp:       { fetch: () => { throw new Error('UrlFetchApp.fetch called in pure context'); } },
  DocumentApp:       { GlyphType: { BULLET: 'BULLET', NUMBER: 'NUMBER' }, ParagraphHeading: {} },
  Logger:            { log: () => {} },
  Utilities:         { base64Encode: (s) => Buffer.from(s).toString('base64'), formatDate: () => '' },
  Session:           { getScriptTimeZone: () => 'UTC' },
  HtmlService:       { createHtmlOutput: () => ({ setWidth: function(){ return this; }, setHeight: function(){ return this; } }) },
  DriveApp:          {},
  MimeType:          { PLAIN_TEXT: 'text/plain' },
};

function loadPureFunctions(configOverrides) {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');

  const sandbox = Object.assign({}, APPS_SCRIPT_STUBS, {
    CONFIG: Object.assign({}, CONFIG_STUB, configOverrides || {}),
    // Capture exports from the script
    _exports: {}
  });

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // Return every function the sandbox defined at the top level
  return {
    adfToBlocks:        sandbox.adfToBlocks,
    autoLinkSegments:   sandbox.autoLinkSegments,
    buildCommentDigest: sandbox.buildCommentDigest,
    // expose STATUS_COLORS for color-assertion tests
    STATUS_COLORS:      sandbox.STATUS_COLORS,
  };
}

module.exports = { loadPureFunctions, CONFIG_STUB };
