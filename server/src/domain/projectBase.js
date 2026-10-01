export const PROJECT_BASES = Object.freeze({
  GO: {
    key:'GO',
    label:'GO',
    title:'Gerenciamento de Obra',
    description:'Base de cronograma da frente GO.',
  },
  GP: {
    key:'GP',
    label:'GP',
    title:'Gerenciamento de Projetos',
    description:'Base de cronograma da frente GP / Coordenação.',
  },
});

export function normalizeProjectBase(value='GO') {
  const base=String(value || 'GO').trim().toUpperCase();
  if (!PROJECT_BASES[base]) throw new Error(`Base inválida: ${value}. Use GO ou GP.`);
  return base;
}

export function sourceModeForProjectBase(driveMode, value='GO') {
  const base=normalizeProjectBase(value);
  // Compatibilidade: a base GO existente continua usando exatamente "local"/"google",
  // assim instalações existentes reaproveitam o banco sem migrar nem reprocessar arquivos.
  return base === 'GO' ? driveMode : `${driveMode}:GP`;
}

export function projectBaseFromSourceMode(sourceMode='') {
  return String(sourceMode).toUpperCase().endsWith(':GP') ? 'GP' : 'GO';
}

export function driveModeFromProjectSourceMode(sourceMode='local') {
  return String(sourceMode || 'local').split(':')[0].toLowerCase();
}

export function relativeCronogramaSegments(area, value='GO') {
  const base=normalizeProjectBase(value);
  if (base === 'GO') return ['GO','CRONOGRAMA'];
  // Regra acordada:
  // Residencial/Corporativo: <OBRA>/GP/COORD/CRONOGRAMA
  // Predial:                  <OBRA>/COORD/CRONOGRAMA
  if (String(area).toUpperCase() === 'PREDIAL') return ['COORD','CRONOGRAMA'];
  return ['GP','COORD','CRONOGRAMA'];
}

export function relativeCronogramaPath(area, value='GO', separator='/') {
  return relativeCronogramaSegments(area,value).join(separator);
}
