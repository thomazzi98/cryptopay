/**
 * Formatting and linting on commit, without hitting the command line length limit.
 *
 * lint-staged passes every staged path as an argument, and Windows caps a command line at about
 * 32,000 characters. A commit touching a hundred files therefore fails with "the command line is too
 * long" rather than with anything about the code, which is a confusing way to be told to make smaller
 * commits — and some commits are legitimately large.
 *
 * Past a threshold the tools are pointed at the repository instead of at a file list. That is slower
 * and it always terminates, which is the right trade for a hook that must not be the reason a change
 * cannot be committed.
 */

const MAXIMUM_EXPLICIT_PATHS = 24;

function quote(path) {
  return `"${path}"`;
}

export default {
  '*.{ts,tsx,js,mjs}': (paths) => {
    if (paths.length > MAXIMUM_EXPLICIT_PATHS) {
      return ['eslint --fix .', 'prettier --write .'];
    }
    const listed = paths.map((path) => quote(path)).join(' ');
    return [`eslint --fix ${listed}`, `prettier --write ${listed}`];
  },
  '*.{json,md,yml,yaml,css}': (paths) => {
    if (paths.length > MAXIMUM_EXPLICIT_PATHS) {
      return ['prettier --write .'];
    }
    return [`prettier --write ${paths.map((path) => quote(path)).join(' ')}`];
  },
};
