export default {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
  // Agent worktrees under .claude/worktrees hold full copies of the repo; their tests are not this checkout's.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/worktrees/'],
  modulePathIgnorePatterns: ['<rootDir>/.claude/worktrees/'],
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};