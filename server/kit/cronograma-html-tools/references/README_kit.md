# Uso rápido dos scripts

```bash
pip install mpxj JPype1                      # uma vez (Java 11+)
python scripts/extrair_mpp.py --out versoes_raw.json v1="…SEMANA 09.mpp" v2="…SEMANA 12.mpp" v3="…SEMANA 14.mpp"
cp references/config_exemplo_dprj.json config.json      # adaptar
python scripts/gerar_html.py config.json --resumo       # conferir pareamento e deltas
python scripts/gerar_html.py config.json                # HTML + _dados.json + _memoria_confronto.csv
```

## Campos do config, por ordem de importância
1. `estratos` — unidade que o cliente reconhece como entrega (pavimento, torre, bloco, casa/quadra, fachada, trecho). `regex` casa com o nome do resumo; `nivel_estrato` é o nível de tópicos desses resumos; `raiz_obra` restringe a busca (ex.: `^OBRA$`).
2. `marcos` — 10 a 16 tarefas-marco pareadas por regex de nome (+ regex do grupo quando o nome se repete). Nomes são normalizados (espaços sobrando não atrapalham); o filtro de grupo é estrito.
3. `campos` — onde a construtora guarda % previsto/realizado (`text1`, `text7`, `num1`…). Ver "campos personalizados" na saída do extrair_mpp.py. Se não existir, omitir.
4. `secao_cliente` / `meta.rotulo_cliente` — seção do cronograma com marcos do cliente/terceiros. Opcional.
5. `versoes` — da mais antiga para a vigente; `status`/`salvo` preenchidos automaticamente. Uma versão só: a aba Confronto some.
6. `eixo` — `inicio`/`fim` do eixo completo; `foco_marcos` e `foco_confronto` = início da janela "Foco".
7. `referencias` — `status`, `ref` (prazos contratuais), `end` (término do plano), `base` (baseline); `lvl` escalona os rótulos.
8. `meta` — títulos, unidade (singular/plural), rótulos dos botões de janela, `kpis` (6), `kpis_confronto` (6), `leitura`, `leitura_confronto`, `notas`, `rodape`. Redigir depois do `--resumo`.

## Limitações conhecidas
- Marcos do cliente só entram num estrato quando a seção do cliente também é dividida pelos mesmos estratos.
- Pareamento entre versões é por nome de tarefa (+ grupo); se a construtora renomear, aceitar as duas grafias no regex: `^(Plaqueamento|Fechamento) de forro$`.
- Sem linha de base: colunas de baseline mostram "—". Sem campo de % previsto: barras cinzas de previsto não são desenhadas.
- O exemplo `config_exemplo_dprj.json` espera `versoes_raw_dprj.json` gerado a partir dos três .mpp da DPRJ (não incluído por tamanho).
