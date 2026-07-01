declare module "*.svg" {
    const content: string;
    export default content;
}

// Vendored so CSS module imports (e.g. explorer.module.css) resolve to a
// typed Record<string, string> even in environments without the
// @types/css-modules devDependency installed.
declare module "*.module.css" {
    const classes: Record<string, string>;
    export default classes;
}

declare module "*.txt" {
    const content: string;
    export default content;
}