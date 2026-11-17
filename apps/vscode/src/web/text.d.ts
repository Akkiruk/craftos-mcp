// esbuild's text loader (esbuild.mjs): a .lua file imported as its text
declare module "*.lua" {
  const text: string;
  export default text;
}
