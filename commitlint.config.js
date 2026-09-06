export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore', 'revert'],
    ],
  },
};
