# GeoRural Proxy WMS Azure Brazil South v1.2

Correções desta versão:

- valida `server.mjs` com `node --check` antes de construir a imagem;
- aceita nome ou URL completa do repositório e normaliza automaticamente;
- solicita token GHCR sem exibi-lo;
- exige credenciais explícitas para `ghcr.io`;
- cria uma revisão exclusiva e valida `/health` após o deploy.

O arquivo `server.mjs` correto começa com:

```js
import http from 'node:http';
import https from 'node:https';
```
