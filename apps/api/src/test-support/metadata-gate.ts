/** Database substitute for worker/service tests. E2E exercises these SQL
 * statements and the row lock against PostgreSQL with separate clients. */
export function metadataGateDatabase() {
  let state = { nextAt: 0, requests: [] as any[] };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    reset() { state = { nextAt: 0, requests: [] }; },
    snapshot() { return structuredClone(state); },
    async $queryRaw(parts: TemplateStringsArray) {
      return parts.join('').includes('clock_timestamp') ? [{ now: new Date() }] : [{ state: structuredClone(state) }];
    },
    async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      if (parts.join('').startsWith('UPDATE')) state = JSON.parse(values[0] as string);
      return 1;
    },
    transaction<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(work);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
