declare module 'vitest' {
  interface ProvidedContext {
    postgresPort: number;
  }
}

export {};
