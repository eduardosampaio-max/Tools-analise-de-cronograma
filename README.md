# Tools analise de cronograma

Aplicação para leitura documental de cronogramas por BU, obra e base **GO/GP**, com extração/OCR persistente, sincronização incremental, análise via OpenRouter e geração de HTML pelo pacote `cronograma-html-tools`.

## Arquitetura

```text
Google Drive
  ↓
GO / GP
  ↓
sincronização incremental
  ↓
SQLite + JSONs + OCR
  ↓
preparação para IA
  ↓
análise via OpenRouter
  ↓
JSON preparado
  ↓
HTML TOOLS
```

O sistema também mantém histórico das análises de cada obra/base. Esse histórico pertence aos resultados das análises e não representa a versão do software.

## Produção

O projeto está preparado para funcionar em **um único Web Service Docker no Render**:

- React é compilado no build;
- Express entrega o frontend e as rotas `/api` no mesmo domínio;
- Python 3 é usado na geração do HTML;
- SQLite, OCR, blobs, snapshots e resultados ficam em `DATA_DIR=/var/data`;
- `/var/data` deve estar ligado a um Persistent Disk;
- a leitura dos arquivos em produção usa Google Drive API.

## Arquivos principais de deploy

```text
Dockerfile
render.yaml
server/.env.render.example
DEPLOY_RENDER.md
```

## Verificação após o deploy

API:

```text
https://SEU-SERVICO.onrender.com/api/ping
```

Resposta esperada:

```json
{"ok":true,"api":"online","timestamp":"..."}
```

Diagnóstico completo:

```text
https://SEU-SERVICO.onrender.com/api/health
```

Depois abra a URL principal do serviço para acessar a interface web.

Consulte `DEPLOY_RENDER.md` para o passo a passo completo.
