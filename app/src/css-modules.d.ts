// Ambient module for CSS Modules. Vite (and vitest's matching plugin) handle
// `.module.css` at build/test time by returning a class-name map; TypeScript
// needs this declaration to know the shape of that default export.
declare module '*.module.css' {
  const classes: { readonly [className: string]: string };
  export default classes;
}
