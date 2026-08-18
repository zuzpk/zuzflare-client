type DynamicImporter = (specifier: string) => Promise<any>;

/**
 * Use Function-based import to keep bundlers from eagerly traversing
 * Node-only modules (e.g. gRPC) into browser bundles.
 */
export const runtimeImport: DynamicImporter = (specifier) => {
    const importer = new Function("s", "return import(s)") as DynamicImporter;
    return importer(specifier);
};
