// The suite runs with vitest's `globals: true`, so describe/it/expect/vi are
// ambient. next build type-checks the test files along with everything else
// and needs the same declarations the test runner provides.
/// <reference types="vitest/globals" />
