// Node provides WebAssembly at runtime, but TypeScript declares it only in its
// DOM libraries. This is the part font-subset.ts uses.
declare namespace WebAssembly {
  class Module {
    constructor(bytes: ArrayBufferView | ArrayBuffer);
  }
  class Instance {
    constructor(module: Module, imports?: object);
    readonly exports: Record<string, unknown>;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
  }
}
