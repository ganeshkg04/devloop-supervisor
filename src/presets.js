'use strict';
// Readiness and error patterns for common tools. A process picks one with
// "preset"; any "signals" it sets itself replace the preset's for that state.
// Each pattern is a regular expression matched against one line of output.

module.exports = {
  // ng build <library> --watch
  'angular-library': {
    building: ['Building Angular Package', 'File change detected'],
    ready: ['Compilation complete\\. Watching for file changes', 'Built Angular Package'],
    error: ['Compilation failed\\. Watching for file changes'],
  },
  // ng serve / npm start in an Angular app
  'angular-app': {
    building: ['Changes detected\\. Rebuilding'],
    ready: ['Application bundle generation complete'],
    error: ['Application bundle generation failed'],
  },
  // vite dev server
  vite: {
    building: [],
    ready: ['ready in \\d', 'hmr update', 'page reload'],
    error: ['Internal server error', 'Pre-transform error', 'error when starting dev server'],
  },
  // tsc --watch
  'tsc-watch': {
    building: ['Starting compilation in watch mode', 'File change detected\\. Starting incremental compilation'],
    ready: ['Found 0 errors\\. Watching for file changes'],
    error: ['Found [1-9]\\d* errors?\\. Watching for file changes'],
  },
  // No readiness output: the process counts as ready once it has started.
  none: { building: [], ready: [], error: [] },
};
