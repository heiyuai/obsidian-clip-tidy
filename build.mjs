import { build } from 'esbuild';
await build({entryPoints:['src/main.ts'],bundle:true,external:['obsidian'],format:'cjs',target:'es2020',outfile:'main.js',minify:false,banner:{js:'/* Clip Tidy v0.2.1 | MIT License */'}});
