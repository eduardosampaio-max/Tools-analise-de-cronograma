#!/usr/bin/env python3
"""
extrair_mpp.py — extrai tarefas de cronogramas nativos (MS Project .mpp/.mpx/.xml MSPDI, Primavera .xer/.xml, Asta, etc.)
para um JSON único, uma chave por versão, usando MPXJ (Java) via JPype.

Uso:
    python extrair_mpp.py --out versoes_raw.json v1="caminho/REV 01 - SEMANA 09.mpp" v2="caminho/SEMANA 12.mpp" v3="caminho/SEMANA 14.mpp"

Convenção: as chaves (v1, v2, ...) vão da versão mais antiga para a vigente; a ÚLTIMA é tratada como plano vigente
pelo gerar_html.py. Use as mesmas chaves no config.json.

Requisitos (uma vez):  pip install mpxj JPype1   (Java 11+ instalado; o pacote mpxj traz os JARs)

Saída por versão: {"info": {...propriedades do projeto...}, "tasks": [ {campos por tarefa} ], "custom_fields": [...]}.
Campos por tarefa: id, uid, wbs, level, name, summary, milestone, active, dur, start, finish, actual_start, actual_finish,
bl_start, bl_finish, bl_dur, pct, pct_work, phys_pct, critical, total_slack, free_slack, finish_var, start_var,
constraint, constraint_date, deadline, notes, preds, resources, text1..text10, num1..num5, flag1..flag5, cost, bl_cost, work.
A lista custom_fields traz os apelidos (aliases) dos campos personalizados — use-a para descobrir em qual TextN/NumberN
a construtora guarda "% previsto" e "% realizado".
"""
import argparse, json, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="arquivo JSON de saída")
    ap.add_argument("versoes", nargs="+", help='pares chave=caminho, ex.: v1="a.mpp" v2="b.mpp"')
    args = ap.parse_args()

    import mpxj  # noqa: F401  (garante o classpath dos JARs)
    import jpype
    if not jpype.isJVMStarted():
        jpype.startJVM()
    from org.mpxj.reader import UniversalProjectReader

    def s(v):
        return None if v is None else str(v)

    def d(v):
        return None if v is None else str(v)[:16]

    out = {}
    for par in args.versoes:
        if "=" not in par:
            sys.exit(f"parâmetro inválido (esperado chave=caminho): {par}")
        key, path = par.split("=", 1)
        pf = UniversalProjectReader().read(path)
        props = pf.getProjectProperties()
        info = {
            "arquivo": path,
            "titulo": s(props.getProjectTitle()), "autor": s(props.getAuthor()), "empresa": s(props.getCompany()),
            "status_date": d(props.getStatusDate()), "start": d(props.getStartDate()), "finish": d(props.getFinishDate()),
            "baseline_finish": d(props.getBaselineFinish()), "last_saved": d(props.getLastSaved()),
            "pct_complete": s(props.getPercentageComplete()),
        }
        rows = []
        for t in pf.getTasks():
            if t.getID() is None:
                continue
            row = {
                "id": int(t.getID().intValue()), "uid": int(t.getUniqueID().intValue()), "wbs": s(t.getWBS()),
                "level": int(t.getOutlineLevel().intValue()) if t.getOutlineLevel() else None,
                "name": s(t.getName()), "summary": bool(t.getSummary()), "milestone": bool(t.getMilestone()),
                "active": bool(t.getActive()), "dur": s(t.getDuration()),
                "start": d(t.getStart()), "finish": d(t.getFinish()),
                "actual_start": d(t.getActualStart()), "actual_finish": d(t.getActualFinish()),
                "bl_start": d(t.getBaselineStart()), "bl_finish": d(t.getBaselineFinish()), "bl_dur": s(t.getBaselineDuration()),
                "pct": s(t.getPercentageComplete()), "pct_work": s(t.getPercentageWorkComplete()), "phys_pct": s(t.getPhysicalPercentComplete()),
                "critical": bool(t.getCritical()), "total_slack": s(t.getTotalSlack()), "free_slack": s(t.getFreeSlack()),
                "finish_var": s(t.getFinishVariance()), "start_var": s(t.getStartVariance()),
                "constraint": s(t.getConstraintType()), "constraint_date": d(t.getConstraintDate()), "deadline": d(t.getDeadline()),
                "notes": s(t.getNotes()),
                "preds": [f"{int(r.getPredecessorTask().getID().intValue())}{r.getType()}{r.getLag()}" for r in t.getPredecessors()],
                "resources": [s(a.getResource().getName()) for a in t.getResourceAssignments() if a.getResource()],
                "cost": s(t.getCost()), "bl_cost": s(t.getBaselineCost()), "work": s(t.getWork()),
            }
            for i in range(1, 11):
                row[f"text{i}"] = s(t.getText(i))
            for i in range(1, 6):
                row[f"num{i}"] = s(t.getNumber(i))
                row[f"flag{i}"] = bool(t.getFlag(i)) if t.getFlag(i) is not None else None
            rows.append(row)
        cfs = []
        for cf in pf.getCustomFields():
            if cf.getAlias():
                cfs.append({"campo": s(cf.getFieldType()), "alias": s(cf.getAlias())})
        out[key] = {"info": info, "tasks": rows, "custom_fields": cfs}
        print(f"[{key}] {path}\n   status {info['status_date']} · término {info['finish']} · baseline {info['baseline_finish']} · % {info['pct_complete']} · {len(rows)} linhas · campos personalizados: {', '.join(c['campo']+'='+c['alias'] for c in cfs) or 'nenhum'}")

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("gravado:", args.out)

if __name__ == "__main__":
    main()
