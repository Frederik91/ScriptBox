interface ScriptBoxBridge {
  /**
   * Invoke a host method directly. The promise settles with the host's answer.
   */
  hostCall(method: string, args: unknown[]): Promise<unknown>;

  /**
   * Create a function that forwards calls to the specified host method.
   */
  createMethod(method: string): (...args: unknown[]) => Promise<unknown>;
}

declare const __scriptbox: ScriptBoxBridge;

// Example scriptbox typings. Consumers are expected to define their
// own interfaces, but we keep these around for samples/tests.
interface FileSystemEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

interface FileSystemApi {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path: string): Promise<FileSystemEntry[]>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
}

interface HttpRequestOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface HttpApi {
  get(url: string): Promise<string>;
  post(url: string, data: any): Promise<string>;
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

interface ScriptBoxApi {
  add(a: number, b: number): Promise<number>;
  subtract(a: number, b: number): Promise<number>;
  fs: FileSystemApi;
  http: HttpApi;
}

declare const scriptbox: ScriptBoxApi;
