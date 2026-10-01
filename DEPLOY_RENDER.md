# Deploy GitHub + Render — Tools analise de cronograma

O projeto foi preparado para produção em **um único Web Service Docker**:

- React é compilado no Docker build;
- Express serve o `client/dist` e as rotas `/api` no mesmo domínio;
- Python 3 é instalado no container para `gerar_html.py`;
- SQLite, blobs, OCR, snapshots e resultados da IA usam `DATA_DIR=/var/data`;
- `/var/data` deve ser um **Persistent Disk** no Render;
- no Render a origem dos arquivos é `DRIVE_MODE=google`.

## 1. Antes de subir no GitHub

Não crie nem envie `server/.env` com chaves reais. O repositório já ignora esse arquivo.

Arquivos de deploy incluídos:

- `Dockerfile`
- `.dockerignore`
- `render.yaml`
- `server/.env.render.example`

## 2. Criar o repositório no GitHub

Na pasta raiz desta aplicação:

```powershell
git init
git branch -M main
git add .
git status
git commit -m "Deploy inicial Tools analise de cronograma"
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git push -u origin main
```

Antes do commit, confirme no `git status` que NÃO aparecem:

- `server/.env`
- `server/data/`
- `node_modules/`
- bancos `.sqlite`
- arquivos de log

## 3. Preparar a Service Account do Google Drive

A aplicação usa Google Drive API quando está no Render.

1. No Google Cloud, use/crie um projeto.
2. Ative a Google Drive API.
3. Crie uma Service Account.
4. Gere a chave JSON da Service Account.
5. Compartilhe com o e-mail da Service Account as três pastas raiz que o sistema precisa ler, com permissão de leitura.
6. Copie o ID de cada pasta raiz do Drive.

No Render, `GOOGLE_SERVICE_ACCOUNT_JSON` deve receber o JSON COMPLETO em uma única variável de ambiente. Não faça commit desse JSON.

## 4. Criar no Render pelo Blueprint

1. Abra o Dashboard do Render.
2. New > Blueprint.
3. Conecte o repositório GitHub.
4. O Render localizará `render.yaml` na raiz.
5. Revise o serviço `tools-analise-cronograma`.
6. O Blueprint solicita as variáveis marcadas como `sync: false`.
7. Preencha as variáveis secretas/IDs abaixo.
8. Faça o deploy.

### Variáveis obrigatórias

```text
OPENROUTER_API_KEY=<sua chave OpenRouter>
GOOGLE_SERVICE_ACCOUNT_JSON=<JSON completo da service account>
GOOGLE_ROOT_RESIDENCIAL_ID=<id da pasta 2_RESIDENCIAL>
GOOGLE_ROOT_CORPORATIVO_ID=<id da pasta 3_CORPORATIVO>
GOOGLE_ROOT_PREDIAL_ID=<id da pasta 4_PREDIAL>
```

O Blueprint já define:

```text
DRIVE_MODE=google
DATA_DIR=/var/data
PYTHON_BIN=python3
AUTO_SYNC_ENABLED=true
AUTO_SYNC_TIMEZONE=America/Sao_Paulo
```

## 5. Persistent Disk

O `render.yaml` cria um disco de 5 GB montado em:

```text
/var/data
```

Não remova esse disco. O sistema grava nele o SQLite, artefatos de extração, blobs, snapshots e resultados de IA.

## 6. Primeiro teste depois do deploy

Abra:

```text
https://SEU-SERVICO.onrender.com/api/ping
```

Esperado:

```json
{"ok":true,"api":"online","timestamp":"..."}
```

Depois abra:

```text
https://SEU-SERVICO.onrender.com/api/health
```

Confira principalmente:

- `driveMode`: `google`
- `database.path`: dentro de `/var/data`
- `ai.configured`: `true`
- `mppReader.available`: `true`
- `htmlOutput.enabled`: `true`
- `htmlOutput.pythonBin`: `python3` ou equivalente
- OCR disponível sem erro fatal

Por fim, abra a URL principal do serviço. O React deve carregar no mesmo domínio da API.

## 7. Teste funcional recomendado

1. Abra **Dados**.
2. Confirme que a lista de obras aparece a partir do Google Drive.
3. Escolha uma obra de teste e base GO/GP.
4. Rode somente essa obra primeiro.
5. Confirme criação do snapshot e dos JSONs/OCR.
6. Baixe o pacote JSON e confira o download.
7. Execute `Teste IA/OpenRouter`.
8. Gere uma análise e confirme HTML + JSON + CSV.
9. Reinicie manualmente o serviço no Render.
10. Confirme que o histórico anterior continua disponível após o restart.

## 8. Atualizações futuras

Depois que estiver funcionando, o fluxo fica:

```powershell
git add .
git commit -m "descricao da alteracao"
git push origin main
```

Com auto deploy habilitado, o Render reconstrói o Docker e publica a atualização. O conteúdo de `/var/data` permanece no Persistent Disk.

## 9. Observação de capacidade

OCR de PDFs, processamento de arquivos grandes e leitura de cronogramas são cargas mais pesadas que um frontend comum. O Blueprint usa `1c-2g` (equivalente ao antigo Standard) em vez de 512 MB para reduzir risco de encerramento por memória. Se a volumetria real ultrapassar a capacidade, aumente o plano sem alterar o código.
