declare module 'vitest' {
  interface ProvidedContext {
    postgresPort: number;
    anvilPort: number;
    anvilTokenAddress: string;
  }
}

export {};
