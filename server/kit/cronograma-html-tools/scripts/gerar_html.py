#!/usr/bin/env python3
"""
gerar_html.py — monta o HTML "Cronograma: marcos por estrato, caminho crítico e confronto de versões" (padrão Tools)
a partir do JSON extraído por extrair_mpp.py e de um config.json que descreve a estratificação do projeto.

Uso:
    python gerar_html.py config.json            # gera o HTML e a memória de cálculo (JSON/CSV) na pasta de saída
    python gerar_html.py config.json --resumo   # só imprime o confronto (para redigir KPIs e "Leitura Tools")

Ver config_exemplo_dprj.json para a estrutura completa. Campos principais:
  raw                : JSON gerado pelo extrair_mpp.py
  versoes            : lista [{key, rotulo, status, salvo}] da mais antiga para a vigente (a última é a vigente)
  raiz_obra          : regex do resumo (nível 2) que contém os estratos da obra (opcional; se ausente, procura em toda a árvore)
  secao_cliente      : regex do resumo cujo subárvore traz os marcos do cliente/terceiros (opcional)
  nivel_estrato      : nível de estrutura de tópicos dos estratos (pavimento, torre, casa, bloco...)
  nivel_grupo        : nível dos grupos/disciplinas dentro do estrato
  estratos           : [{id, nome, curto, regex}] na ordem de exibição
  marcos             : [{label, tarefa (regex), grupo (regex opcional)}] — marcos de obra a exibir, pareados por nome
  campos             : {"prev": "text1", "real": "text7"} — campos de % previsto/realizado da construtora (opcional)
  siglas             : lista de siglas a manter em maiúsculas nos nomes de disciplina
  eixo, referencias, meta, saida
"""
import argparse, csv, json, os, re, sys, datetime as dt
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
SIGLAS_PADRAO = ["CPD", "CFTV", "SPK", "SDAI", "IDF", "MDF", "HVAC", "VRF", "VAV", "GLP", "SPDA", "AVCB", "TI", "UPS", "QGBT", "QDF",
                 "CAG", "ETE", "ETA", "PMOC", "ART", "FVS", "PIT", "FAT", "SAT", "AV", "LED", "CCM", "QTA", "GMG", "BMS", "DG"]

def D(x):
    return x[:10] if x else None

def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def dias(a, b):
    if not a or not b:
        return None
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days

def frase(nome, siglas):
    n = (nome or "").strip()
    if not n:
        return n
    low = n.lower()
    out = low[0].upper() + low[1:]
    for sg in siglas:
        out = re.sub(rf"\b{re.escape(sg.lower())}\b", sg, out, flags=re.IGNORECASE)
    return out

def indexar(versao, cfg):
    """Constrói, para uma versão, as estruturas por estrato: resumo do estrato, grupos, folhas, críticos e itens do cliente."""
    T = [t for t in versao["tasks"] if (t["level"] or 0) >= 1 and t["name"] and t["name"].strip()]
    for t in T:
        t["name"] = re.sub(r"\s+", " ", t["name"].strip())
    byid = {t["id"]: t for t in T}
    stack, parent = [], {}
    for t in T:
        lvl = t["level"] or 0
        while stack and (byid[stack[-1]]["level"] or 0) >= lvl:
            stack.pop()
        parent[t["id"]] = stack[-1] if stack else None
        stack.append(t["id"])

    def cadeia(tid):
        out = []
        while tid is not None:
            out.append(byid[tid]); tid = parent[tid]
        return out[::-1]

    est_re = [(e["id"], re.compile(e["regex"], re.I)) for e in cfg["estratos"]]
    raiz_re = re.compile(cfg["raiz_obra"], re.I) if cfg.get("raiz_obra") else None
    cli_re = re.compile(cfg["secao_cliente"], re.I) if cfg.get("secao_cliente") else None
    nE, nG = int(cfg.get("nivel_estrato", 3)), int(cfg.get("nivel_grupo", 4))
    campos = cfg.get("campos", {})

    def estrato_de(nomes):
        for n in nomes:
            for eid, rx in est_re:
                if rx.search(n):
                    return eid
        return None

    F = {e["id"]: {"resumo": None, "grupos": OrderedDict(), "folhas": [], "criticos": [], "cliente": []} for e in cfg["estratos"]}
    for t in T:
        ch = cadeia(t["id"]); nomes = [c["name"] for c in ch]
        # está dentro da seção do cliente?
        em_cli = cli_re is not None and any(cli_re.search(n) for n in nomes[:-1] + ([t["name"]] if t["summary"] else []))
        if em_cli and cli_re.search(t["name"]) and t["summary"]:
            continue
        if em_cli:
            eid = estrato_de(nomes[:-1])
            if eid and not t["summary"]:
                F[eid]["cliente"].append({"name": t["name"], "level": max(4, t["level"] or 4), "start": D(t["start"]), "finish": D(t["finish"]),
                                          "ms": bool(t["milestone"]), "summary": False, "slack": t["total_slack"], "pct": t["pct"]})
            continue
        # dentro da raiz da obra?
        if raiz_re is not None and not any(raiz_re.search(n) for n in nomes[:-1] + [t["name"]]):
            continue
        lvl = t["level"] or 0
        if lvl == nE and t["summary"]:
            eid = estrato_de([t["name"]])
            if eid and F[eid]["resumo"] is None:
                F[eid]["resumo"] = t
            continue
        if lvl <= nE:
            continue
        eid = estrato_de([c["name"] for c in ch if (c["level"] or 0) == nE])
        if not eid:
            continue
        grupo = next((c["name"] for c in ch if (c["level"] or 0) == nG), None)
        if lvl == nG and t["summary"]:
            F[eid]["grupos"][t["name"]] = t
        elif not t["summary"]:
            F[eid]["folhas"].append((grupo or "", t))
            if t["critical"]:
                F[eid]["criticos"].append((grupo or "", t))
    return F, campos

def achar(folhas, tarefa_re, grupo_re):
    """Localiza a tarefa-marco: regex sobre o nome normalizado (sem espaços duplicados/laterais); se 'grupo' for informado,
    a tarefa precisa estar sob um grupo cujo nome case com o regex (filtro estrito). Empate: primeira na ordem da EAP."""
    rx_t = re.compile(tarefa_re, re.I); rx_g = re.compile(grupo_re, re.I) if grupo_re else None
    cands = [(g, t) for g, t in folhas if rx_t.search(re.sub(r"\s+", " ", (t["name"] or "").strip()))]
    if rx_g:
        cands = [(g, t) for g, t in cands if rx_g.search(re.sub(r"\s+", " ", (g or "").strip()))]
    return cands[0] if cands else (None, None)

def montar(cfg):
    raw = json.load(open(cfg["raw"], encoding="utf-8"))
    vers = cfg["versoes"]
    for v in vers:
        if v["key"] not in raw:
            sys.exit(f"versão {v['key']} não existe em {cfg['raw']} (chaves: {list(raw)})")
    cur = vers[-1]["key"]
    IDX = {v["key"]: indexar(raw[v["key"]], cfg) for v in vers}
    siglas = cfg.get("siglas", SIGLAS_PADRAO)
    campos = cfg.get("campos", {})
    fprev, freal = campos.get("prev"), campos.get("real")
    pv = lambda t, f: (t.get(f) if f else None)

    DATA = {"status_date": D(raw[cur]["info"]["status_date"]), "floors": {}, "cliente": {}, "critical": {}}
    MS = {}
    VER = {"status": {}, "floors": {}} if len(vers) >= 2 else None
    for v in vers:
        info = raw[v["key"]]["info"]
        v.setdefault("data_status", D(info["status_date"]))
        v.setdefault("status", dt.date.fromisoformat(v["data_status"]).strftime("%d/%m") if v.get("data_status") else "")
        if info.get("last_saved") and not v.get("salvo"):
            v["salvo"] = dt.date.fromisoformat(D(info["last_saved"])).strftime("%d/%m")
        if VER is not None:
            VER["status"][v["key"]] = {"date": v["data_status"], "label": v["rotulo"], "pct": info["pct_complete"], "saved": D(info.get("last_saved")), "finish": D(info["finish"])}

    memoria = []
    for e in cfg["estratos"]:
        eid = e["id"]
        Fc, _ = IDX[cur]
        Ec = Fc[eid]
        if Ec["resumo"] is None:
            print(f"AVISO: estrato {eid} não encontrado na versão vigente (regex {e['regex']}); será omitido.")
            continue
        r = Ec["resumo"]
        # grupos (disciplinas) — versão vigente
        grupos = []
        for gname, g in Ec["grupos"].items():
            grupos.append({"id": g["id"], "name": frase(gname, siglas), "raw": gname, "start": D(g["start"]), "finish": D(g["finish"]),
                           "bl_start": D(g["bl_start"]), "bl_finish": D(g["bl_finish"]), "pct": g["pct"], "prev": (pv(g, fprev) or "").strip() or None,
                           "crit": bool(g["critical"]), "slack": g["total_slack"], "dur": g["dur"]})
        DATA["floors"][eid] = {"groups": grupos, "finish": D(r["finish"]), "bl_finish": D(r["bl_finish"]), "pct": r["pct"],
                               "prev": (pv(r, fprev) or "").strip() or None, "real": (pv(r, freal) or "").strip() or None, "slack": r["total_slack"]}
        DATA["cliente"][eid] = Ec["cliente"]
        crit = sorted(Ec["criticos"], key=lambda gt: (gt[1]["start"] or "", gt[1]["id"]))
        DATA["critical"][eid] = [{"id": t["id"], "name": t["name"], "start": D(t["start"]), "finish": D(t["finish"]), "pct": t["pct"], "group": frase(g, siglas)} for g, t in crit][:60]
        # marcos — versão vigente
        ms = []
        for m in cfg["marcos"]:
            g, t = achar(Ec["folhas"], m["tarefa"], m.get("grupo"))
            if t is None:
                continue
            ms.append({"label": m["label"], "task": t["name"], "group": g, "date": D(t["finish"]), "start": D(t["start"]), "bl": D(t["bl_finish"]),
                       "pct": float(t["pct"] or 0), "crit": bool(t["critical"]), "slack": t["total_slack"], "kind": "obra", "id": t["id"]})
        ms.sort(key=lambda m: (m["date"] or "9999", m["id"]))
        MS[eid] = ms
        # confronto de versões
        if VER is not None:
            fo = {"milestones": [], "groups": [], "cliente": {}, "summary": {}}
            for v in vers:
                Fv, _ = IDX[v["key"]]; Ev = Fv[eid]; rv = Ev["resumo"]
                fo["summary"][v["key"]] = {"finish": D(rv["finish"]), "bl_finish": D(rv["bl_finish"]), "pct": rv["pct"], "prev": (pv(rv, fprev) or "").strip() or None,
                                           "real": (pv(rv, freal) or "").strip() or None, "slack": rv["total_slack"]} if rv else None
                fo["cliente"][v["key"]] = Ev["cliente"]
            for m in cfg["marcos"]:
                row = {"label": m["label"], "task": None, "group": None, "crit_cur": False, "v": {}}
                for v in vers:
                    Fv, _ = IDX[v["key"]]
                    g, t = achar(Fv[eid]["folhas"], m["tarefa"], m.get("grupo"))
                    if t is None:
                        row["v"][v["key"]] = None
                    else:
                        row["v"][v["key"]] = {"date": D(t["finish"]), "start": D(t["start"]), "pct": float(t["pct"] or 0), "crit": bool(t["critical"]), "slack": t["total_slack"], "id": t["id"]}
                        if v["key"] == cur:
                            row["task"], row["group"], row["crit_cur"] = t["name"], g, bool(t["critical"])
                if all(x is None for x in row["v"].values()):
                    continue
                fo["milestones"].append(row)
                dcur = row["v"][cur]["date"] if row["v"][cur] else None
                memoria.append({"estrato": eid, "marco": m["label"], **{f"{v['rotulo']}": (row["v"][v["key"]] or {}).get("date") for v in vers},
                                **{f"Δ {v['rotulo']}→{vers[-1]['rotulo']} (d)": dias((row["v"][v["key"]] or {}).get("date"), dcur) for v in vers[:-1]},
                                **{f"% {v['rotulo']}": (row["v"][v["key"]] or {}).get("pct") for v in vers}})
            for gname in Ec["grupos"]:
                gr = {"name": frase(gname, siglas), "v": {}}
                for v in vers:
                    Fv, _ = IDX[v["key"]]
                    g = Fv[eid]["grupos"].get(gname) or next((gg for n, gg in Fv[eid]["grupos"].items() if norm(n) == norm(gname)), None)
                    gr["v"][v["key"]] = {"start": D(g["start"]), "finish": D(g["finish"]), "bl_start": D(g["bl_start"]), "bl_finish": D(g["bl_finish"]),
                                         "pct": float(g["pct"] or 0), "prev": (pv(g, fprev) or "").strip() or None, "real": (pv(g, freal) or "").strip() or None,
                                         "slack": g["total_slack"], "crit": bool(g["critical"])} if g else None
                fo["groups"].append(gr)
            VER["floors"][eid] = fo
    return DATA, MS, VER, memoria

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--resumo", action="store_true", help="só imprime o confronto, sem gerar arquivos")
    tpl_default = next((c for c in [os.path.join(HERE, "cronograma_marcos_template.html"),
                                    os.path.join(HERE, "..", "assets", "cronograma_marcos_template.html")] if os.path.exists(c)),
                       os.path.join(HERE, "..", "assets", "cronograma_marcos_template.html"))
    ap.add_argument("--template", default=tpl_default)
    args = ap.parse_args()
    cfg = json.load(open(args.config, encoding="utf-8"))
    os.chdir(os.path.dirname(os.path.abspath(args.config)))
    DATA, MS, VER, memoria = montar(cfg)
    vers = cfg["versoes"]

    # ---- resumo no terminal
    for eid in DATA["floors"]:
        F = DATA["floors"][eid]
        print(f"\n== {eid}: término {F['finish']} · baseline {F['bl_finish']} · folga {F['slack']} · % {F['pct']} · prev {F['prev']} · real {F['real']}")
        for m in MS[eid]:
            print(f"   {'*' if m['crit'] else ' '} {m['label'][:46]:46} {m['date']}  bl {m['bl']}  {m['pct']:.0f}%  folga {m['slack']}")
        if VER:
            print("   confronto:")
            for row in VER["floors"][eid]["milestones"]:
                ds = [(row["v"][v["key"]] or {}).get("date") for v in vers]
                dl = [dias(d0, ds[-1]) for d0 in ds[:-1]]
                print(f"     {row['label'][:42]:42} " + " | ".join(str(d) for d in ds) + "   Δ " + " / ".join("—" if d is None else f"{d:+d}" for d in dl))
    if args.resumo:
        return

    # ---- arquivos
    meta = dict(cfg["meta"])
    meta["versoes"] = [{"key": v["key"], "rotulo": v["rotulo"], "status": v.get("status", ""), "data_status": v.get("data_status"), "salvo": v.get("salvo")} for v in vers] if VER else []
    meta["estratos"] = [{"id": e["id"], "nome": e.get("nome", e["id"]), "curto": e.get("curto", e["id"])} for e in cfg["estratos"] if e["id"] in DATA["floors"]]
    meta["data_status"] = DATA["status_date"]
    meta["eixo"] = cfg["eixo"]
    meta["referencias"] = cfg.get("referencias", [])
    tpl = open(args.template, encoding="utf-8").read()
    html = (tpl.replace("__TITULO__", meta.get("titulo", "Cronograma"))
               .replace("__META__", json.dumps(meta, ensure_ascii=False))
               .replace("__DATA__", json.dumps(DATA, ensure_ascii=False))
               .replace("__MS__", json.dumps(MS, ensure_ascii=False))
               .replace("__VER__", json.dumps(VER, ensure_ascii=False)))
    saida = cfg.get("saida", "cronograma_marcos.html")
    os.makedirs(os.path.dirname(os.path.abspath(saida)), exist_ok=True)
    open(saida, "w", encoding="utf-8").write(html)
    base = os.path.splitext(saida)[0]
    json.dump({"META": meta, "DATA": DATA, "MS": MS, "VER": VER}, open(base + "_dados.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if memoria:
        with open(base + "_memoria_confronto.csv", "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(memoria[0].keys()), delimiter=";")
            w.writeheader(); w.writerows(memoria)
    print(f"\ngravado: {saida}\n         {base}_dados.json" + (f"\n         {base}_memoria_confronto.csv" if memoria else ""))

if __name__ == "__main__":
    main()
