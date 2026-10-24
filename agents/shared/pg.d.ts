declare module "pg" {
  export class Pool {
    constructor(config: { connectionString: string });
    query(
      text: string,
      values?: unknown[]
    ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
    end(): Promise<void>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
