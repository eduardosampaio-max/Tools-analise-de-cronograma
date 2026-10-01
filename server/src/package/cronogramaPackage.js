import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const ROOT = path.join(config.serverRoot, 'kit', 'cronograma-html-tools');
const PROMPT_PATH = path.join(config.serverRoot, 'prompts', 'PROMPT_Cronograma_HTML_Tools_R01_curto.md');

const FILES = {
  skill:path.join(ROOT,'SKILL.md'),
  manual:path.join(ROOT,'references','manual_metodo_completo.md'),
  readme:path.join(ROOT,'references','README_kit.md'),
  configExample:path.join(ROOT,'references','config_exemplo_dprj.json'),
  evals:path.join(ROOT,'evals','evals.json'),
  template:path.join(ROOT,'assets','cronograma_marcos_template.html'),
  extractor:path.join(ROOT,'scripts','extrair_mpp.py'),
  renderer:path.join(ROOT,'scripts','gerar_html.py'),
  prompt:PROMPT_PATH,
};

function text(file) { return fs.readFileSync(file,'utf8'); }
function sha256Bytes(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256File(file) { return sha256Bytes(fs.readFileSync(file)); }

export function packageProfile() {
  const files = Object.entries(FILES).map(([name,file])=>({
    name,
    relativePath:path.relative(config.serverRoot,file).replaceAll('\\','/'),
    exists:fs.existsSync(file),
    sha256:fs.existsSync(file) ? sha256File(file) : null,
    bytes:fs.existsSync(file) ? fs.statSync(file).size : 0,
  }));
  const missing = files.filter(x=>!x.exists);
  const packageHash = sha256Bytes(Buffer.from(files.map(x=>`${x.name}:${x.sha256||'missing'}`).join('\n')));
  return {
    name:'cronograma-html-tools',
    locked:true,
    complete:missing.length===0,
    packageHash,
    files,
    missing:missing.map(x=>x.name),
    aiInputContract:'Somente o JSON Contexto canônico para IA do projeto selecionado é enviado como dados da obra ao modelo; as respostas de qualificação entram dentro do mesmo contexto.',
    aiOutputContract:'A IA retorna somente JSON de resultado preparado; o HTML é gerado deterministicamente por scripts/gerar_html.py + template da skill.',
  };
}

export function loadPackageInstructions() {
  const profile = packageProfile();
  if (!profile.complete) throw new Error(`Pacote cronograma-html-tools incompleto: ${profile.missing.join(', ')}`);
  return {
    profile,
    prompt:text(FILES.prompt),
    skill:text(FILES.skill),
    manual:text(FILES.manual),
    readme:text(FILES.readme),
    configExample:JSON.parse(text(FILES.configExample)),
    evals:JSON.parse(text(FILES.evals)),
  };
}

export const PREPARED_RESULT_SCHEMA_TEXT = `{
  "schemaVersion": "tools.cronograma.result.v1",
  "status": "ready|preliminary|needs_confirmation",
  "packageCompliance": {"package": "cronograma-html-tools", "followed": true, "notes": []},
  "reading": {
    "currentSchedule": {"file": "", "statusDate": null, "plannedFinish": null, "baselineFinish": null, "percentComplete": null},
    "versionsCompared": [{"file":"", "label":"", "statusDate":null}],
    "nativeFileAvailable": true
  },
  "qualification": {"contractFinish": null, "purpose": null, "assumptions": []},
  "stratification": {
    "recommended": {"id":"", "label":"", "reason":""},
    "alternatives": [{"id":"", "label":"", "reason":""}],
    "selected": {"id":"", "label":"", "reason":""}
  },
  "checks": {
    "progress": {"declared": null, "recalculated": null, "differencePoints": null, "warning": null},
    "overdueTasks": [],
    "criticalPath": [],
    "nextGate": null,
    "versionChanges": [],
    "clientThirdPartyMilestones": [],
    "deadlineComparison": {"contract": null, "schedule": null, "baseline": null, "conciled": null, "note": ""}
  },
  "kitConfig": {
    "raw": "__VERSOES_RAW_JSON__",
    "versoes": [{"key":"v1", "rotulo":""}],
    "raiz_obra": null,
    "secao_cliente": null,
    "nivel_estrato": 3,
    "nivel_grupo": 4,
    "estratos": [{"id":"", "nome":"", "curto":"", "regex":""}],
    "campos": {},
    "marcos": [{"label":"", "tarefa":"", "grupo":null}],
    "eixo": {"inicio":"YYYY-MM-DD", "fim":"YYYY-MM-DD", "foco_marcos":"YYYY-MM-DD", "foco_confronto":"YYYY-MM-DD"},
    "referencias": [{"d":"YYYY-MM-DD", "label":"", "kind":"status|ref|end|base", "lvl":0}],
    "meta": {
      "titulo":"", "subtitulo":"", "unidade":"", "unidade_plural":"", "rotulo_cliente":"", "descricao_cliente":"",
      "rotulo_foco":"", "rotulo_full":"", "rotulos_curtos":{},
      "kpis":[{"classe":"ok|warn|crit", "l":"", "v":"", "n":""}],
      "kpis_confronto":[{"classe":"ok|warn|crit", "l":"", "v":"", "n":""}],
      "leitura":"", "leitura_confronto":"", "notas":[],
      "rodape":"Documento de trabalho da gerenciadora (Tools Gerenciamento e Engenharia). Não substitui o cronograma oficial da construtora."
    },
    "saida": "__OUTPUT_HTML__"
  },
  "executiveSummary": ["até 10 linhas em linguagem simples"],
  "meetingQuestions": ["pergunta 1", "pergunta 2", "pergunta 3"],
  "premises": [],
  "warnings": [],
  "traceability": [{"claim":"", "sources":[{"file":"", "path":"", "taskId":null, "wbs":null}]}]
}`;

export function validatePreparedResult(result) {
  const errors=[];
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ['resultado não é um objeto JSON'];
  if (result.schemaVersion !== 'tools.cronograma.result.v1') errors.push('schemaVersion deve ser tools.cronograma.result.v1');
  if (!['ready','preliminary','needs_confirmation'].includes(result.status)) errors.push('status inválido');
  if (result.packageCompliance?.followed !== true) errors.push('packageCompliance.followed deve ser true');
  if (!result.reading?.currentSchedule) errors.push('reading.currentSchedule ausente');
  if (result.status === 'ready' && result.reading?.nativeFileAvailable !== true) errors.push('status ready exige cronograma nativo disponível');
  if (!result.stratification?.selected?.id) errors.push('stratification.selected.id ausente');
  if (!result.checks || typeof result.checks !== 'object') errors.push('checks ausente');
  const cfg=result.kitConfig;
  if (!cfg || typeof cfg !== 'object') errors.push('kitConfig ausente');
  else {
    if (!Array.isArray(cfg.versoes) || !cfg.versoes.length) errors.push('kitConfig.versoes deve conter ao menos uma versão');
    if (!Array.isArray(cfg.estratos) || !cfg.estratos.length) errors.push('kitConfig.estratos deve conter ao menos um estrato');
    if (!Array.isArray(cfg.marcos) || !cfg.marcos.length) errors.push('kitConfig.marcos deve conter marcos detectados');
    else if (result.status === 'ready' && (cfg.marcos.length < 10 || cfg.marcos.length > 16)) errors.push('status ready exige de 10 a 16 marcos conforme o pacote');
    if (!cfg.eixo || !cfg.eixo.inicio || !cfg.eixo.fim) errors.push('kitConfig.eixo deve informar início e fim');
    if (!Array.isArray(cfg.referencias)) errors.push('kitConfig.referencias deve ser array');
    if (!cfg.meta || typeof cfg.meta !== 'object') errors.push('kitConfig.meta ausente');
    else {
      if (!Array.isArray(cfg.meta.kpis) || cfg.meta.kpis.length !== 6) errors.push('kitConfig.meta.kpis deve conter exatamente 6 cartões');
      if ((cfg.versoes?.length||0) >= 2 && (!Array.isArray(cfg.meta.kpis_confronto) || cfg.meta.kpis_confronto.length !== 6)) errors.push('kitConfig.meta.kpis_confronto deve conter exatamente 6 cartões quando houver confronto');
      if (!cfg.meta.leitura) errors.push('kitConfig.meta.leitura ausente');
      if ((cfg.versoes?.length||0) >= 2 && !cfg.meta.leitura_confronto) errors.push('kitConfig.meta.leitura_confronto ausente quando houver confronto');
      if (!Array.isArray(cfg.meta.notas)) errors.push('kitConfig.meta.notas deve ser array');
    }
  }
  if (!Array.isArray(result.executiveSummary) || result.executiveSummary.length < 1 || result.executiveSummary.length > 10) errors.push('executiveSummary deve ter de 1 a 10 itens');
  if (!Array.isArray(result.meetingQuestions) || result.meetingQuestions.length !== 3) errors.push('meetingQuestions deve conter exatamente 3 perguntas');
  return errors;
}

export function packageSystemPrompt(extraValidationErrors=[]) {
  const p=loadPackageInstructions();
  const validation = extraValidationErrors.length ? `\n\nA tentativa anterior falhou nestes pontos de validação. Corrija todos sem alterar os fatos do contexto:\n- ${extraValidationErrors.join('\n- ')}` : '';
  return `Você executa o pacote TOOLS cronograma-html-tools em modo BLOQUEADO. As regras abaixo são a fonte de verdade do método. Não substitua, redesenhe ou simplifique o método por conhecimento externo.\n\n=== PROMPT OPERACIONAL ANEXADO ===\n${p.prompt}\n\n=== SKILL ANEXADA ===\n${p.skill}\n\n=== MANUAL DE MÉTODO DO PACOTE ===\n${p.manual}\n\n=== README DO KIT ===\n${p.readme}\n\n=== CONFIG DE REFERÊNCIA DO KIT ===\n${JSON.stringify(p.configExample,null,2)}\n\n=== EVALS DE ACEITAÇÃO DO PACOTE ===\n${JSON.stringify(p.evals,null,2)}\n\nCONTRATO DE ENTRADA:\n- A mensagem do usuário será EXCLUSIVAMENTE o JSON chamado \"Contexto canônico para IA\".\n- O contexto pode conter o campo userQualification, com respostas dadas pelo usuário ANTES da análise final (prazo contratual, finalidade, estratificação escolhida e confirmação/destaque de marcos). Respeite essas respostas como qualificação autorizada.\n- Não presuma acesso aos JSONs mestres, ao G:, a arquivos originais ou a qualquer dado que não esteja nesse contexto.\n- Se um dado necessário não constar, registre \"não consta\"/premissa conforme o pacote.\n- Se o contexto contiver analysisLayer.mode=\"incremental_update\", use analysisLayer.previousResult como base do trabalho: preserve o que não foi afetado e atualize somente conclusões sustentadas pelos períodos escolhidos, deltaFiles e evidências direcionadas. Não refaça a análise inteira por padrão.\n- Se analysisLayer.requestedPeriods estiver presente, compare SOMENTE os períodos selecionados pelo usuário; não introduza versões fora dessa seleção.\n- Se analysisLayer.requestedChange ou userQualification.userRequest estiver presente, essa é a mudança solicitada para a nova versão: aplique-a somente onde houver suporte nos dados e preserve o restante do resultado anterior.\n- periodicity e comparisonPeriods em userQualification são obrigatórios para versionamento e devem aparecer nas premissas/rastreabilidade quando relevantes.\n\nCONTRATO DE SAÍDA:\n- Retorne SOMENTE JSON válido, sem Markdown e sem HTML.\n- Esse JSON é o \"resultado preparado\" que alimentará a etapa determinística do kit.\n- Use exatamente esta estrutura-base:\n${PREPARED_RESULT_SCHEMA_TEXT}\n- kitConfig deve ser compatível com references/config_exemplo_dprj.json e scripts/gerar_html.py.\n- Não escreva o HTML; o template do pacote fará isso depois.\n- Preserve evidências/rastreabilidade para datas, marcos, atrasos e caminho crítico.\n- Se houver mais de uma versão, versoes deve ir da mais antiga para a vigente.\n- Proponha 10 a 16 marcos quando a evidência permitir; não invente marcos ausentes.\n- Mantenha exatamente 6 KPIs normais e, quando houver 2+ versões, 6 KPIs de confronto.\n- Entregue exatamente 3 perguntas para reunião.\n${validation}`;
}
