/**
 * APP — interface do ONE PAGE EXECUTIVO. Só esta camada toca o DOM.
 * Consome Engines (cálculo) e Db (persistência); nunca calcula "na mão"
 * dentro da renderização — todo número exibido vem de Engines.
 */
(function () {
  "use strict";
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const E = window.Engines;
  const S = window.SeedData;

  const MESES_ABREV = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

  const State = {
    view: "dashboard",
    modo: "carregando", // carregando | live | indisponivel
    usuarioAtual: safeLocalGet("ope_usuario") || "",
    indicadores: [],
    areas: [],
    categorias: [],
    usuarios: [],
    competenciasPorIndicador: {}, // { indicadorId: { "2026-09": {entradas,...} } }
    historicoCache: {}, // { indicadorId: [eventos] }
    competenciaFoco: null,
    periodo: "ano", // 1m | 3m | 6m | 12m | ano | tudo — janela consolidada no Dashboard.
    // Padrão "ano": o painel é executivo e anual, então "Resultado atual"
    // significa o acumulado/média do ano corrente. O filtro continua
    // disponível para olhar janelas menores.
    filtros: { competencia: null, area: "", categoria: "", status: "", responsavel: "" },
    lupaAberta: null, // indicadorId
    editAberto: null, // indicadorId
    respEditAberto: null, // usuarioId | "__novo__"
    unsubs: [],
    // "ano" pilota a Grade do Ano (12 meses de uma vez); "focoComp" rola/realça
    // uma linha específica ao chegar vindo da lupa; "modoAvancadoComp" abre o
    // formulário completo (com campos-tabela) para uma competência específica.
    atualizarSel: { indicadorId: "", ano: "", focoComp: null, modoAvancadoComp: null },
    // Rascunho em memória do que a pessoa está digitando na Grade do Ano —
    // existe para não perder texto ainda não salvo de OUTRAS linhas quando um
    // watchCompetencias ao vivo dispara um render() no meio do preenchimento
    // (ex.: ao salvar uma linha, o snapshot daquele indicador chega e re-
    // renderiza a tabela inteira). Formato: { [indicadorId]: { [competencia]: { [campoKey]: valorDigitado } } }
    rascunhoGrade: {},
    // Importação em lote (copiar/colar) — ver drawerImportar(). Sem
    // dependência de biblioteca externa e sem baixar arquivo (Artifacts
    // publicados bloqueiam downloads iniciados pela própria página): o
    // "modelo" é copiado da tela para a área de transferência, preenchido
    // no Excel/Sheets e colado de volta aqui.
    importar: { aberto: false, escopo: "todos", ano: null, modoModelo: null, modeloGerado: "", colado: "", preview: null, resultadoFinal: null },
  };

  function safeLocalGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeLocalSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ------------------------------------------------------------- format --
  function formatarResultado(v, unidade) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    const opt = (min, max) => v.toLocaleString("pt-BR", { minimumFractionDigits: min, maximumFractionDigits: max });
    switch (unidade) {
      case "%": return opt(1, 2) + "%";
      case "dias": return opt(0, 1) + " d";
      case "qtd": return Math.round(v).toLocaleString("pt-BR");
      case "h": return opt(0, 1) + "h";
      case "R$/Mil": return "R$ " + opt(0, 1) + " mil";
      case "R$": return "R$ " + Math.round(v).toLocaleString("pt-BR");
      case "km/l": return opt(1, 2) + " km/l";
      default: return String(v);
    }
  }
  function competenciaLabel(comp) {
    if (!comp) return "—";
    const [a, m] = comp.split("-").map(Number);
    return `${MESES_ABREV[m]}/${a}`;
  }
  function competenciaAnterior(comp) {
    let [a, m] = comp.split("-").map(Number);
    m -= 1; if (m === 0) { m = 12; a -= 1; }
    return `${a}-${String(m).padStart(2, "0")}`;
  }
  function fmtDataHora(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function nomeUsuario(id) {
    const u = State.usuarios.find((x) => x.id === id);
    return u ? u.nome : id || "—";
  }
  function usuarioPorId(id) { return State.usuarios.find((x) => x.id === id) || null; }
  const PERFIL_LABEL = { administrador: "Administrador", gestor: "Gestor", operacional: "Operacional" };
  function nomeArea(id) { return (State.areas.find((a) => a.id === id) || {}).nome || id; }
  function nomeCategoria(id) { return (State.categorias.find((c) => c.id === id) || {}).nome || id; }

  // ------------------------------------------------------------- cálculo --
  function serieResultados(indicador, competenciasMap) {
    const out = {};
    Object.keys(competenciasMap || {}).forEach((comp) => {
      const { resultado } = E.calcularResultadoCompetencia(indicador, competenciasMap[comp].entradas);
      out[comp] = resultado;
    });
    return out;
  }

  function visaoIndicador(indicador, competenciaFoco) {
    const compsMap = State.competenciasPorIndicador[indicador.id] || {};
    const serie = serieResultados(indicador, compsMap);
    const docAtual = compsMap[competenciaFoco];
    const { resultado: resultadoProprio, detalhes } = docAtual
      ? E.calcularResultadoCompetencia(indicador, docAtual.entradas)
      : { resultado: null, detalhes: null };

    let derivado = null;
    if (indicador.calc.motor === "comparativo_proporcional_anual") {
      derivado = E.calcularDerivado(indicador, serie, competenciaFoco);
    } else if (indicador.calc.acumulativo) {
      derivado = E.calcularDerivado(indicador, serie, competenciaFoco);
    }

    const ehComparativo = indicador.calc.motor === "comparativo_proporcional_anual";
    const resultadoCard = ehComparativo ? (derivado && derivado.valor ? derivado.valor.percentual : null) : resultadoProprio;
    const unidadeCard = ehComparativo ? "%" : indicador.unidade;
    const status = E.calcularSaude(indicador, resultadoCard, detalhes);

    const resultadoAnteriorProprio = serie[competenciaAnterior(competenciaFoco)];
    let resultadoAnteriorCard = resultadoAnteriorProprio;
    if (ehComparativo) {
      const compAnt = competenciaAnterior(competenciaFoco);
      const [anoAnt, mesAnt] = compAnt.split("-").map(Number);
      const derivAnt = E.motorComparativoProporcional(
        Object.fromEntries(Object.entries(serie).filter(([k]) => k.startsWith(anoAnt + "-"))),
        anoAnt, mesAnt
      );
      resultadoAnteriorCard = derivAnt ? derivAnt.percentual : null;
    }

    const serieOrdenada = Object.keys(serie).sort().map((comp) => ({ comp, valor: serie[comp] }));

    return {
      indicador, docAtual, resultadoProprio, detalhes, derivado, status,
      resultadoCard, unidadeCard, resultadoAnteriorCard, serieOrdenada, serie,
      existeDado: !!docAtual,
    };
  }

  // --------------------------------------------------------- período ----
  function competenciaSeguinte(comp) {
    let [a, m] = comp.split("-").map(Number);
    m += 1; if (m === 13) { m = 1; a += 1; }
    return `${a}-${String(m).padStart(2, "0")}`;
  }
  function gerarListaCompetencias(inicio, fim) {
    const out = [];
    let cur = inicio, guard = 0;
    while (cur <= fim && guard < 600) { out.push(cur); cur = competenciaSeguinte(cur); guard++; }
    return out;
  }
  function menorCompetenciaDisponivel() {
    let menor = null;
    Object.values(State.competenciasPorIndicador).forEach((mapa) => {
      Object.keys(mapa).forEach((c) => { if (!menor || c < menor) menor = c; });
    });
    return menor;
  }
  // Gera a lista de competências do período selecionado, terminando em
  // `mesFim`. Isto é o que substitui o antigo "um mês só" do filtro.
  function competenciasDoPeriodo(periodoKey, mesFim) {
    if (!mesFim) return [];
    if (periodoKey === "1m") return [mesFim];
    if (periodoKey === "ano") {
      const [ano, mesN] = mesFim.split("-");
      const out = [];
      for (let m = 1; m <= Number(mesN); m++) out.push(`${ano}-${String(m).padStart(2, "0")}`);
      return out;
    }
    if (periodoKey === "tudo") {
      const min = menorCompetenciaDisponivel();
      return min ? gerarListaCompetencias(min, mesFim) : [mesFim];
    }
    const n = { "3m": 3, "6m": 6, "12m": 12 }[periodoKey] || 6;
    const out = [];
    let cur = mesFim;
    for (let i = 0; i < n; i++) { out.unshift(cur); cur = competenciaAnterior(cur); }
    return out;
  }
  // Mesmo tamanho de janela, imediatamente anterior ao período atual —
  // usado só para calcular a seta de tendência (período vs período).
  function periodoAnterior(competencias) {
    if (!competencias.length) return [];
    const n = competencias.length;
    const fim = competenciaAnterior(competencias[0]);
    const out = [];
    let cur = fim;
    for (let i = 0; i < n; i++) { out.unshift(cur); cur = competenciaAnterior(cur); }
    return out;
  }
  // Colunas mensais da Matriz Executiva: SEMPRE o ano civil completo
  // (Jan a Dez) do ano da competência-foco, independente do "Período"
  // selecionado. Isto resolve o problema de meses lançados (ex.: Jan/Fev/
  // Mar) somem da tela só porque ficaram fora da janela rolante do
  // período — a partir de agora a leitura de trajetória do ano é sempre
  // visível; o filtro de Período continua controlando apenas a janela de
  // CONSOLIDAÇÃO (resultado atual, tendência e KPIs), não mais as colunas.
  function competenciasDoAno(foco) {
    if (!foco) return [];
    const ano = foco.split("-")[0];
    const out = [];
    for (let m = 1; m <= 12; m++) out.push(`${ano}-${String(m).padStart(2, "0")}`);
    return out;
  }
  function rotuloPeriodoTexto(competencias) {
    if (!competencias.length) return "Nenhuma competência disponível.";
    if (competencias.length === 1) return `Mês de referência: <strong>${competenciaLabel(competencias[0])}</strong>.`;
    return `Consolidado de <strong>${competenciaLabel(competencias[0])}</strong> a <strong>${competenciaLabel(competencias[competencias.length - 1])}</strong> (${competencias.length} meses).`;
  }

  // Visão de um indicador agregada num PERÍODO (vários meses) — é o que
  // alimenta os cards do Dashboard. Delega toda a semântica de "como
  // consolidar" para Engines.calcularResultadoPeriodo (nunca soma um
  // status/derivado aqui "na mão").
  function visaoIndicadorPeriodo(indicador, competenciasPeriodo) {
    const compsMap = State.competenciasPorIndicador[indicador.id] || {};
    const entradasPorCompetencia = {};
    Object.keys(compsMap).forEach((c) => { entradasPorCompetencia[c] = compsMap[c].entradas; });
    const serieCompleta = serieResultados(indicador, compsMap);

    const agregado = E.calcularResultadoPeriodo(indicador, entradasPorCompetencia, competenciasPeriodo);
    const ultimaComDado = agregado.ultimaComDado;
    const docAtual = ultimaComDado ? compsMap[ultimaComDado] : null;

    let derivado = null;
    if (ultimaComDado && (indicador.calc.motor === "comparativo_proporcional_anual" || indicador.calc.acumulativo)) {
      derivado = E.calcularDerivado(indicador, serieCompleta, ultimaComDado);
    }

    const ehComparativo = indicador.calc.motor === "comparativo_proporcional_anual";
    const resultadoCard = ehComparativo ? (derivado && derivado.valor ? derivado.valor.percentual : null) : agregado.resultado;
    const unidadeCard = ehComparativo ? "%" : indicador.unidade;
    const status = E.calcularSaude(indicador, resultadoCard, agregado.detalhes);

    const compsAnterior = periodoAnterior(competenciasPeriodo);
    const agregadoAnterior = E.calcularResultadoPeriodo(indicador, entradasPorCompetencia, compsAnterior);
    let resultadoAnteriorCard = agregadoAnterior.resultado;
    if (ehComparativo) {
      const ultimaAnt = agregadoAnterior.ultimaComDado;
      if (ultimaAnt) {
        const [anoAnt, mesAnt] = ultimaAnt.split("-").map(Number);
        const derivAnt = E.motorComparativoProporcional(
          Object.fromEntries(Object.entries(serieCompleta).filter(([k]) => k.startsWith(anoAnt + "-"))), anoAnt, mesAnt
        );
        resultadoAnteriorCard = derivAnt ? derivAnt.percentual : null;
      } else resultadoAnteriorCard = null;
    }

    const serieOrdenada = competenciasPeriodo.map((comp) => ({ comp, valor: serieCompleta[comp] }));
    // Trend do sparkline sempre olha o histórico completo (não só a janela
    // do período selecionado) — o período recorta o número de cabeçalho,
    // não o contexto de tendência mostrado no gráfico.
    const serieOrdenadaCompleta = Object.keys(serieCompleta).sort().map((comp) => ({ comp, valor: serieCompleta[comp] }));

    return {
      indicador, docAtual, detalhes: agregado.detalhes, derivado, status,
      resultadoCard, unidadeCard, resultadoAnteriorCard, serieOrdenada, serieOrdenadaCompleta, serie: serieCompleta,
      existeDado: agregado.competenciasComDado.length > 0,
      competenciasComDado: agregado.competenciasComDado, ultimaComDado,
    };
  }

  // ------------------------------------------------------------- sparkline
  function svgSparkline(serie, { w = 220, h = 46, statusColor = "var(--accent)", labels = false } = {}) {
    const pontos = serie.filter((p) => typeof p.valor === "number");
    if (pontos.length < 2) {
      return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><text x="4" y="${h / 2 + 4}" font-size="11" fill="var(--muted)">dados insuficientes para tendência</text></svg>`;
    }
    const vals = pontos.map((p) => p.valor);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    const padTop = labels ? 16 : 4, padBottom = labels ? 18 : 4, padX = 4;
    const innerH = h - padTop - padBottom;
    const stepX = (w - padX * 2) / (pontos.length - 1);
    const coords = pontos.map((p, i) => {
      const x = padX + i * stepX;
      const y = padTop + innerH - ((p.valor - min) / range) * innerH;
      return [x, y];
    });
    const path = coords.map((c, i) => (i === 0 ? `M${c[0]},${c[1]}` : `L${c[0]},${c[1]}`)).join(" ");
    const area = `${path} L${coords[coords.length - 1][0]},${padTop + innerH} L${coords[0][0]},${padTop + innerH} Z`;
    const last = coords[coords.length - 1];
    let out = `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="tendência">`;
    out += `<line x1="${padX}" y1="${padTop + innerH}" x2="${w - padX}" y2="${padTop + innerH}" stroke="var(--border-strong)" stroke-width="1"/>`;
    out += `<path d="${area}" fill="${statusColor}" opacity="0.12" stroke="none"/>`;
    out += `<path d="${path}" fill="none" stroke="${statusColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    out += `<circle cx="${last[0]}" cy="${last[1]}" r="3" fill="${statusColor}"/>`;
    if (labels) {
      out += `<text x="${coords[0][0]}" y="12" font-size="10" fill="var(--muted)">${competenciaLabel(pontos[0].comp)}</text>`;
      out += `<text x="${last[0]}" y="12" font-size="10" fill="var(--muted)" text-anchor="end">${competenciaLabel(pontos[pontos.length - 1].comp)}</text>`;
    }
    out += `</svg>`;
    return out;
  }

  function corStatus(status) {
    return { verde: "var(--verde)", amarelo: "var(--amarelo)", azul: "var(--azul)", vermelho: "var(--vermelho)" }[status] || "var(--muted)";
  }

  function pillStatus(status) {
    return `<span class="status-pill ${status}"><span class="dot"></span>${E.STATUS_LABEL[status] || status}</span>`;
  }

  // ------------------------------------------------------------- boot ----
  async function boot(hotData) {
    Object.assign(State, hotData || {});
    State.progresso = "Conectando ao banco de dados…";
    render();
    try {
      await window.Db.init();
      await window.Db.ensureSeeded(S, (msg) => { State.progresso = msg; render(); });
      await window.Db.ensureCamposNovos(S);
      State.progresso = "Carregando cadastro…";
      render();
      await carregarConfig();
      inscreverAoVivo();
      State.modo = window.Db.isMock() ? "local" : "live";
    } catch (e) {
      State.modo = "indisponivel";
      State.erro = (e && e.message) || String(e);
    }
    if (!State.competenciaFoco) State.competenciaFoco = ultimaCompetenciaDisponivel() || window.Db.mesAtualISO();
    render();
  }

  function ultimaCompetenciaDisponivel() {
    let ultima = null;
    Object.values(State.competenciasPorIndicador).forEach((mapa) => {
      Object.keys(mapa).forEach((c) => { if (!ultima || c > ultima) ultima = c; });
    });
    return ultima;
  }

  // Só carrega o CADASTRO (áreas/categorias/usuários/indicadores) — poucos
  // documentos, rápido. As competências (que podem ser centenas de
  // documentos) chegam via as inscrições ao vivo em inscreverAoVivo(), que
  // já entregam o estado atual assim que se conectam — buscá-las aqui de
  // novo seria uma segunda leitura redundante e mais lenta para o mesmo dado.
  async function carregarConfig() {
    const [indicadores, areas, categorias, usuarios] = await Promise.all([
      window.Db.listarIndicadores(), window.Db.listarAreas(), window.Db.listarCategorias(), window.Db.listarUsuarios(),
    ]);
    State.indicadores = indicadores.sort((a, b) => a.id.localeCompare(b.id));
    State.areas = areas; State.categorias = categorias; State.usuarios = usuarios;
    // Sessão real (Supabase Auth): quem está logado é sempre a pessoa da
    // sessão — não há mais seleção manual de usuário.
    const eu = window.Auth && window.Auth.usuarioLogado();
    if (eu) State.usuarioAtual = eu.id;
    else if (!State.usuarioAtual && usuarios[0]) State.usuarioAtual = usuarios[0].id;
  }

  function inscreverAoVivo() {
    State.unsubs.forEach((u) => u());
    State.unsubs = [];
    State.unsubs.push(window.Db.watchIndicadores((lista) => {
      State.indicadores = lista.sort((a, b) => a.id.localeCompare(b.id));
      render();
    }));
    State.indicadores.forEach((ind) => {
      State.unsubs.push(window.Db.watchCompetencias(ind.id, (mapa) => {
        State.competenciasPorIndicador[ind.id] = mapa;
        render();
      }));
    });
  }

  // ------------------------------------------------------------- render -
  function render() {
    renderTopbar();
    const main = $("#main");
    if (State.modo === "indisponivel") {
      main.innerHTML = viewIndisponivel();
      return;
    }
    if (State.modo === "carregando") {
      main.innerHTML = `<div class="empty-state">${State.progresso || "Carregando…"}</div>`;
      return;
    }
    try {
      if (State.view === "dashboard") main.innerHTML = viewDashboard();
      else if (State.view === "atualizar") main.innerHTML = viewAtualizar();
      else if (State.view === "indicadores") main.innerHTML = viewIndicadores();
      else if (State.view === "responsaveis") main.innerHTML = viewResponsaveis();
      else if (State.view === "historico") main.innerHTML = viewHistorico();
      renderModais();
      wireViewEvents();
    } catch (e) {
      console.error("Erro ao renderizar:", e);
      main.innerHTML = `<div class="empty-state"><div class="big">⚠️</div><h3>Ocorreu um erro ao exibir esta tela</h3>
        <p class="mono" style="font-size:11.5px">${(e && e.message) || e}</p>
        <p style="margin-top:10px"><button class="btn" id="retry-render">Tentar novamente</button></p></div>`;
      const retry = $("#retry-render");
      if (retry) retry.addEventListener("click", () => { State.view = "dashboard"; render(); });
    }
  }

  function renderTopbar() {
    const bar = $("#topbar");
    const tabs = [["dashboard", "Dashboard"], ["atualizar", "Atualizar"], ["indicadores", "Indicadores"], ["responsaveis", "Responsáveis"], ["historico", "Histórico"]];
    bar.innerHTML = `
      <div class="topbar-row">
        <div class="brand"><span class="logo-chip"><img src="logo.png" alt="Âmbar Energia" /></span><span class="sub"><strong>One Page Executivo</strong><br/>Gestão Administrativa · Regional Centro Sul</span></div>
        <nav class="tabs">${tabs.map(([k, l]) => `<button data-view="${k}" class="${State.view === k ? "active" : ""}">${l}</button>`).join("")}</nav>
        <div class="spacer"></div>
        <span class="badge-mode ${State.modo === "live" ? "live" : ""}" title="${State.modo === "local" ? "Pré-visualização local (sem o runtime do Artifact) — publique a página para usar o banco de dados real e sincronização entre usuários." : ""}">${State.modo === "live" ? "● dados ao vivo" : State.modo === "local" ? "◐ pré-visualização local" : State.modo === "carregando" ? "conectando…" : "banco indisponível"}</span>
        <div class="userpicker" title="Sessão autenticada — cada pessoa entra com a própria conta. A troca pelo login corporativo Microsoft (Entra ID) não exigirá recadastro.">
          Você é <strong>${nomeUsuario(State.usuarioAtual)}</strong>
          <button class="editbtn" id="btn-sair" style="margin-left:8px">Sair</button>
        </div>
      </div>
      <div class="brand-strip"></div>`;
    $$("button[data-view]", bar).forEach((b) => b.addEventListener("click", () => { State.view = b.dataset.view; render(); }));
    const btnSair = $("#btn-sair", bar);
    if (btnSair) btnSair.addEventListener("click", () => window.Auth.sair());
  }

  function viewIndisponivel() {
    return `<div class="empty-state"><div class="big">🔌</div><h3>Não foi possível carregar os dados</h3>
      <p>Esta página depende do banco de dados estruturado do Artifact. Tente recarregar a página.</p>
      ${State.erro ? `<p class="mono" style="font-size:11.5px;margin-top:10px">${State.erro}</p>` : ""}</div>`;
  }

  // ------------------------------------------------------------- dashboard
  function indicadoresVisiveis() {
    return State.indicadores.filter((i) => i.ativo);
  }

  // Um indicador "precisa de atenção" quando está vermelho, ou amarelo E
  // piorando em relação ao período anterior (na direção definida no
  // cadastro — maior_melhor/menor_melhor). Para indicadores sem direção
  // definida (faixa/informativo), só o vermelho conta — nunca inventamos
  // uma direção de "melhor" que o cadastro não definiu.
  function precisaAtencao(v) {
    if (v.status === "vermelho") return true;
    if (v.status !== "amarelo") return false;
    const dir = v.indicador.saude.tipo;
    if (typeof v.resultadoCard !== "number" || typeof v.resultadoAnteriorCard !== "number") return false;
    if (dir === "maior_melhor") return v.resultadoCard < v.resultadoAnteriorCard;
    if (dir === "menor_melhor") return v.resultadoCard > v.resultadoAnteriorCard;
    return false;
  }

  // Descreve a trajetória dos últimos pontos SEM inventar julgamento de
  // "melhor/pior" quando o cadastro não define uma direção (ver item 8 do
  // pedido do usuário: nada de regra de saúde inventada). Compara o valor
  // atual contra o valor de até 3 competências atrás, na série histórica
  // completa (independente do período selecionado no filtro).
  function analisarTendencia(indicador, v) {
    const pontos = v.serieOrdenadaCompleta.filter((p) => typeof p.valor === "number");
    if (pontos.length < 2) return "dados insuficientes para tendência";
    const janela = Math.min(3, pontos.length - 1);
    const atual = pontos[pontos.length - 1].valor;
    const antes = pontos[pontos.length - 1 - janela].valor;
    const delta = atual - antes;
    const dir = indicador.saude.tipo;
    const rotuloJanela = janela === 1 ? "no mês anterior" : `nos últimos ${janela} meses`;
    if (delta === 0) return `estável ${rotuloJanela}`;
    if (dir === "maior_melhor") return `${delta > 0 ? "melhora" : "queda"} ${rotuloJanela}`;
    if (dir === "menor_melhor") return `${delta < 0 ? "melhora" : "alta"} ${rotuloJanela}`;
    // Sem direção configurada (faixa / faixa_por_contagem / faixa_assinada /
    // informativo): descreve o movimento sem qualificar como bom ou ruim.
    const un = indicador.unidadeMensal || indicador.unidade;
    return `variação de ${formatarResultado(antes, un)} para ${formatarResultado(atual, un)} ${rotuloJanela}`;
  }

  function linhaInterpretacao(v) {
    const { indicador, resultadoCard, unidadeCard, derivado, existeDado } = v;
    const partes = [];
    const sufixoAcumulado = indicador.calc.acumulativo ? (indicador.id === "ADM-024" ? " (consolidado)" : " (acumulado no ano)") : "";
    partes.push(`Resultado atual: <strong class="num">${formatarResultado(resultadoCard, unidadeCard)}</strong>${sufixoAcumulado}`);
    if (!existeDado) {
      partes.push(`<span class="tag-neutro">sem lançamento no período</span>`);
    } else if (precisaAtencao(v)) {
      partes.push(`<span class="tag-atencao">⚠ Atenção</span>`);
    } else {
      partes.push(`<span class="tag-ok">Dentro do esperado</span>`);
    }
    partes.push(`Tendência: ${analisarTendencia(indicador, v)}`);
    return partes.join(" <span class=\"sep\">·</span> ");
  }

  // Rótulo curto do mês para as colunas da matriz — só mostra o ano quando
  // o período atravessa mais de um ano civil (evita ambiguidade em "12
  // meses"/"tudo" sem poluir a leitura de janelas dentro do mesmo ano).
  function mesesCurto(competencias) {
    const anos = new Set(competencias.map((c) => c.split("-")[0]));
    const comAno = anos.size > 1;
    return competencias.map((c) => {
      const [a, m] = c.split("-").map(Number);
      return comAno ? `${MESES_ABREV[m]}/${String(a).slice(2)}` : MESES_ABREV[m];
    });
  }

  function pillStatusMini(status) {
    return `<span class="status-pill status-pill-mini ${status}" title="${E.STATUS_LABEL[status] || status}"><span class="dot"></span></span>`;
  }

  function viewDashboard() {
    const foco = State.competenciaFoco;
    const periodoKey = State.periodo || "6m";
    const competenciasPeriodo = competenciasDoPeriodo(periodoKey, foco);
    const todos = indicadoresVisiveis().map((ind) => visaoIndicadorPeriodo(ind, competenciasPeriodo));
    const filtrados = todos.filter((v) => {
      const f = State.filtros;
      if (f.area && v.indicador.area !== f.area) return false;
      if (f.categoria && v.indicador.categoria !== f.categoria) return false;
      if (f.status && v.status !== f.status) return false;
      if (f.responsavel && v.indicador.responsavelId !== f.responsavel) return false;
      return true;
    });

    // ---- KPIs executivos (item 7 — nada de "saúde geral" inventada) ----
    const acompanhados = todos.length;
    const pontosAtencao = todos.filter(precisaAtencao);
    const emDeterioracao = todos.filter((v) => {
      const dir = v.indicador.saude.tipo;
      if (dir !== "maior_melhor" && dir !== "menor_melhor") return false; // sem direção definida: não entra nessa contagem
      if (typeof v.resultadoCard !== "number" || typeof v.resultadoAnteriorCard !== "number") return false;
      return dir === "maior_melhor" ? v.resultadoCard < v.resultadoAnteriorCard : v.resultadoCard > v.resultadoAnteriorCard;
    });
    const atualizadosNoPeriodo = todos.filter((v) => v.ultimaComDado === foco);

    const competenciasDisponiveis = Array.from(new Set(Object.values(State.competenciasPorIndicador).flatMap((m) => Object.keys(m)))).sort().reverse();
    if (!competenciasDisponiveis.includes(foco)) competenciasDisponiveis.unshift(foco);

    // Colunas mensais: ano civil completo (Jan–Dez) do ano da competência-
    // foco — sempre as mesmas 12, tenham ou não dado lançado (ver
    // competenciasDoAno acima). O "Período" segue controlando apenas a
    // consolidação usada no resultado atual/tendência/KPIs.
    const anoFoco = foco ? foco.split("-")[0] : null;
    const colunasAno = competenciasDoAno(foco);
    const rotulosMes = mesesCurto(colunasAno);
    const mesAtual = window.Db.mesAtualISO();

    // ---- Matriz agrupada por CATEGORIA (ordem fixa do cadastro) --------
    const porCategoria = {};
    filtrados.forEach((v) => { (porCategoria[v.indicador.categoria] = porCategoria[v.indicador.categoria] || []).push(v); });
    const categoriasOrdenadas = State.categorias.filter((c) => porCategoria[c.id]);

    const corpoHtml = !filtrados.length
      ? `<div class="empty-state"><div class="big">🔍</div>Nenhum indicador para os filtros selecionados.</div>`
      : categoriasOrdenadas.map((cat) => `
        <div class="matrix-section">
          <div class="matrix-cat-head">
            <h2>${cat.nome}</h2><span class="count">${porCategoria[cat.id].length} indicador(es)</span>
            <span class="saude-categoria-placeholder" title="Ainda não definimos uma fórmula oficial para consolidar a saúde de vários indicadores — este espaço fica reservado até essa regra existir.">saúde da categoria — a definir</span>
          </div>
          <div class="matrix-table">
            ${matrixHeaderRow(rotulosMes)}
            ${porCategoria[cat.id].map((v) => matrixRow(v, colunasAno, mesAtual)).join("")}
          </div>
        </div>`).join("");

    return `
      <div class="kpi-row">
        <div class="stat-tile total"><div class="n num">${acompanhados}</div><div class="l">Indicadores acompanhados</div></div>
        <div class="stat-tile vermelho"><div class="n num">${pontosAtencao.length}</div><div class="l">Pontos de atenção</div></div>
        <div class="stat-tile amarelo"><div class="n num">${emDeterioracao.length}</div><div class="l">Em deterioração</div></div>
        <div class="stat-tile info"><div class="n num">${atualizadosNoPeriodo.length}/${acompanhados}</div><div class="l">Atualização do período</div></div>
      </div>
      ${pontosAtencao.length ? `<div class="atencao-box"><div>⚠️</div><div style="flex:1"><strong>${pontosAtencao.length} indicador(es) pedem atenção</strong> — onde olhar primeiro:
        <div class="atencao-list">${pontosAtencao.slice(0, 12).map((v) => `
          <button class="atencao-row" data-lupa="${v.indicador.id}">
            <span class="ar-id">${v.indicador.id}</span>
            <span class="ar-nome">${v.indicador.nome}</span>
            <span class="ar-resultado num">${formatarResultado(v.resultadoCard, v.unidadeCard)}</span>
            <span class="ar-resp">${v.indicador.responsavelId ? nomeUsuario(v.indicador.responsavelId) : "sem responsável"}</span>
          </button>`).join("")}</div>
      </div></div>` : ""}
      <div class="filterbar">
        <label>Competência final<select id="f-comp">${competenciasDisponiveis.map((c) => `<option value="${c}" ${c === foco ? "selected" : ""}>${competenciaLabel(c)}</option>`).join("")}</select></label>
        <label title="Define a janela usada para calcular o resultado atual, a tendência e os KPIs — as colunas mensais da matriz abaixo sempre mostram o ano civil completo.">Período<select id="f-periodo">
          <option value="1m" ${periodoKey === "1m" ? "selected" : ""}>Somente este mês</option>
          <option value="3m" ${periodoKey === "3m" ? "selected" : ""}>Últimos 3 meses</option>
          <option value="6m" ${periodoKey === "6m" ? "selected" : ""}>Últimos 6 meses</option>
          <option value="12m" ${periodoKey === "12m" ? "selected" : ""}>Últimos 12 meses</option>
          <option value="ano" ${periodoKey === "ano" ? "selected" : ""}>Ano até este mês</option>
          <option value="tudo" ${periodoKey === "tudo" ? "selected" : ""}>Todo o histórico</option>
        </select></label>
        <label>Área<select id="f-area"><option value="">Todas</option>${State.areas.map((a) => `<option value="${a.id}" ${State.filtros.area === a.id ? "selected" : ""}>${a.nome}</option>`).join("")}</select></label>
        <label>Categoria<select id="f-cat"><option value="">Todas</option>${State.categorias.map((c) => `<option value="${c.id}" ${State.filtros.categoria === c.id ? "selected" : ""}>${c.nome}</option>`).join("")}</select></label>
        <label>Responsável<select id="f-resp"><option value="">Todos</option>${State.usuarios.filter((u) => u.ativo !== false).map((u) => `<option value="${u.id}" ${State.filtros.responsavel === u.id ? "selected" : ""}>${u.nome}</option>`).join("")}</select></label>
        <label>Status<select id="f-status"><option value="">Todos</option>${["verde", "amarelo", "azul", "vermelho", "sem_informacao", "informativo"].map((s) => `<option value="${s}" ${State.filtros.status === s ? "selected" : ""}>${E.STATUS_LABEL[s]}</option>`).join("")}</select></label>
        <button class="clear" id="f-clear">Limpar filtros</button>
      </div>
      <p class="periodo-label"><span class="tri"></span>
        <span class="periodo-label-text">
          <span>${rotuloPeriodoTexto(competenciasPeriodo)}</span>
          <span class="periodo-label-sub">As colunas mensais abaixo mostram sempre o ano civil completo${anoFoco ? ` de <strong>${anoFoco}</strong>` : ""} — inclusive meses ainda sem lançamento.</span>
        </span>
      </p>
      ${corpoHtml}
      <footer class="note">Dados reais · reprocessamento automático a cada correção de competência.</footer>
    `;
  }

  function matrixHeaderRow(rotulosMes) {
    return `<div class="matrix-row matrix-row-head">
      <div class="matrix-row-scroll">
        <div class="mrow-id-block">Indicador</div>
        <div class="mrow-unidade-block" title="Unidade de medida dos valores mensais">Un.</div>
        <div class="mrow-months">${rotulosMes.map((r) => `<div class="mm-cell mm-head">${r}</div>`).join("")}</div>
        <div class="mrow-result-block"><span>Atual</span><span class="mrh-saude">Saúde</span><span></span></div>
      </div>
    </div>`;
  }

  // `colunas` = sempre as 12 competências do ano civil em foco (ver
  // competenciasDoAno); `mesAtual` = mês corrente real (window.Db.
  // mesAtualISO()), usado só para decidir se uma célula vazia é "ainda não
  // chegou a vez" (futuro/mês corrente, neutro) ou "já passou e não foi
  // lançado" (alerta vermelho — item pedido pelo usuário).
  function matrixRow(v, colunas, mesAtual) {
    const { indicador, resultadoCard, unidadeCard, status, serie } = v;
    const respUsuario = indicador.responsavelId ? usuarioPorId(indicador.responsavelId) : null;
    const atencao = precisaAtencao(v);
    const unidadeMensal = indicador.unidadeMensal || indicador.unidade || "—";
    // Clicar numa célula de mês abre o lançamento/correção daquela
    // competência ali mesmo, sem sair do Dashboard (item pedido pelo
    // usuário: "editar direto na Matriz") — reaproveita o mesmo formulário
    // completo (com campos-tabela) usado no modo avançado da tela Atualizar.
    const monthCells = colunas.map((comp) => {
      const val = serie[comp];
      const semDado = typeof val !== "number";
      const foraDeVigencia = !!indicador.competenciaInicial && comp < indicador.competenciaInicial;
      if (foraDeVigencia) {
        return `<div class="mm-cell mm-na" title="${competenciaLabel(comp)}: indicador ainda não era medido nesta competência">·</div>`;
      }
      const atrasado = semDado && mesAtual && comp < mesAtual;
      const cls = semDado ? (atrasado ? "mm-vazio mm-atraso" : "mm-vazio") : "";
      const dica = atrasado ? `${competenciaLabel(comp)}: competência já encerrada sem lançamento — clique para lançar` : `${competenciaLabel(comp)}: clique para lançar ou corrigir`;
      return `<div class="mm-cell mm-editavel ${cls}" title="${dica}" data-editar-mes data-ind="${indicador.id}" data-comp="${comp}">${semDado ? "—" : formatarResultado(val, unidadeMensal)}</div>`;
    }).join("");
    return `<div class="matrix-row ${atencao ? "matrix-row-atencao" : ""}">
      <div class="matrix-row-scroll">
        <div class="mrow-id-block">
          <div class="mrow-top"><span class="mrow-id">${indicador.id}</span><span class="cat-tag" style="font-size:9.5px">${nomeArea(indicador.area)}</span></div>
          <div class="mrow-nome">${indicador.nome}</div>
          <div class="mrow-resp" title="Responsável pelo indicador">${respUsuario ? "👤 " + respUsuario.nome : "sem responsável"}</div>
        </div>
        <div class="mrow-unidade-block" title="Unidade de medida dos valores mensais">${unidadeMensal}</div>
        <div class="mrow-months">${monthCells}</div>
        <div class="mrow-result-block">
          <span class="mrow-resultado num">${formatarResultado(resultadoCard, unidadeCard)}</span>
          ${pillStatusMini(status)}
          <button class="lupa-btn" data-lupa="${indicador.id}" title="Detalhar indicador" aria-label="Detalhar indicador">🔍</button>
        </div>
      </div>
      <div class="mrow-interp">${linhaInterpretacao(v)}</div>
    </div>`;
  }

  // ------------------------------------------------------------- atualizar
  // Anos oferecidos no seletor: todo ano com pelo menos uma competência
  // lançada em qualquer indicador, mais o ano corrente (garante que a
  // pessoa sempre consiga começar um ano novo do zero).
  function anosDisponiveis() {
    const anos = new Set();
    Object.values(State.competenciasPorIndicador).forEach((mapa) => Object.keys(mapa).forEach((c) => anos.add(c.split("-")[0])));
    anos.add(window.Db.mesAtualISO().split("-")[0]);
    return Array.from(anos).sort().reverse();
  }

  function viewAtualizar() {
    const ativos = indicadoresVisiveis();
    const sel = State.atualizarSel;
    const ind = ativos.find((i) => i.id === sel.indicadorId);
    const anos = anosDisponiveis();
    const ano = sel.ano || anos[0];
    const corpo = ind
      ? renderGradeAno(ind, ano)
      : `<p style="color:var(--muted)">Selecione um indicador para lançar ou corrigir valores — a tela mostra o ano inteiro de uma vez, sem precisar reabrir o formulário a cada mês.</p>`;
    return `<div class="form-card ${ind ? "form-card-wide" : ""}">
      <div class="atualizar-head">
        <h3>Atualizar indicador</h3>
        <button type="button" class="btn ghost" id="abrir-importar">📋 Importar vários meses de uma vez</button>
      </div>
      <div class="form-row">
        <div class="field"><label for="at-ind">Indicador</label>
          <select id="at-ind"><option value="">Selecione…</option>
            ${State.areas.map((a) => `<optgroup label="${a.nome}">${ativos.filter((i) => i.area === a.id).map((i) => `<option value="${i.id}" ${i.id === sel.indicadorId ? "selected" : ""}>${i.id} — ${i.nome}</option>`).join("")}</optgroup>`).join("")}
          </select></div>
        ${ind ? `<div class="field" style="flex:0 0 110px;min-width:110px"><label for="at-ano">Ano</label>
          <select id="at-ano">${anos.map((a) => `<option value="${a}" ${a === ano ? "selected" : ""}>${a}</option>`).join("")}</select></div>` : ""}
      </div>
      <div id="at-corpo">${corpo}</div>
    </div>`;
  }

  // Grade do Ano — item pedido pelo usuário para acabar com "reselecionar o
  // mês a cada lançamento": mostra as 12 competências do ano de uma vez,
  // cada uma com seus próprios campos e botão de salvar, para um mutirão de
  // atualização rápido. Campos do tipo "tabela" (detalhamentos opcionais)
  // continuam fora da grade — abrem no formulário completo via "+ detalhes",
  // que preserva o que já estiver salvo naquele campo ao gravar pela grade.
  function renderGradeAno(ind, ano) {
    const compsMap = State.competenciasPorIndicador[ind.id] || {};
    const mesAtual = window.Db.mesAtualISO();
    const camposSimples = ind.camposEntrada.filter((c) => c.tipo !== "tabela");
    const camposTabela = ind.camposEntrada.filter((c) => c.tipo === "tabela");
    const rascunhoInd = State.rascunhoGrade[ind.id] || {};
    const linhas = [];
    for (let m = 1; m <= 12; m++) {
      const comp = `${ano}-${String(m).padStart(2, "0")}`;
      const doc = compsMap[comp];
      const entradasExibir = Object.assign({}, doc ? doc.entradas : {}, rascunhoInd[comp] || {});
      const semDado = !doc;
      // Indicador que começou a ser medido no meio do ano: os meses
      // anteriores não aceitam lançamento nem contam como pendência.
      const foraDeVigencia = !!ind.competenciaInicial && comp < ind.competenciaInicial;
      const atrasado = !foraDeVigencia && semDado && comp < mesAtual;
      const foco = State.atualizarSel.focoComp === comp;
      linhas.push(`
        <tr class="linha-grade ${atrasado ? "linha-atraso" : ""} ${foraDeVigencia ? "linha-na" : ""} ${foco ? "linha-foco" : ""}" data-comp="${comp}">
          <td class="gm-mes">${MESES_ABREV[m]}</td>
          ${foraDeVigencia
            ? camposSimples.map(() => `<td class="gm-na">—</td>`).join("")
            : camposSimples.map((c) => `<td data-campo="${c.key}"${c.mostrarSe ? ` data-mostrar-se='${JSON.stringify(c.mostrarSe)}'` : ""}>${campoHtmlCompacto(c, entradasExibir)}</td>`).join("")}
          <td class="gm-status">${foraDeVigencia ? '<span class="tag-neutro">não medido</span>' : semDado ? (atrasado ? '<span class="tag-atencao">pendente</span>' : '<span class="tag-neutro">sem lançamento</span>') : `<span class="tag-ok">lançado</span>`}</td>
          <td class="gm-acoes">
            ${foraDeVigencia ? "" : `<button type="button" class="btn-mini salvar-linha" data-comp="${comp}">Salvar</button>
            ${camposTabela.length ? `<button type="button" class="btn-mini ghost avancado-linha" data-comp="${comp}" title="Editar ${camposTabela.map((c) => c.label.toLowerCase()).join(", ")}">+ detalhes</button>` : ""}`}
          </td>
        </tr>`);
    }
    return `
      <div class="grade-ano-wrap">
        <table class="grade-ano" data-ind="${ind.id}">
          <thead><tr>
            <th class="gm-mes">Mês</th>
            ${camposSimples.map((c) => `<th>${c.label}${c.obrigatorio ? " *" : ""}</th>`).join("")}
            <th>Situação</th><th></th>
          </tr></thead>
          <tbody>${linhas.join("")}</tbody>
        </table>
      </div>
      <div class="grade-ano-rodape">
        <p class="hint">Preencha quantos meses quiser e salve linha por linha, ou use "Salvar alterações" para gravar de uma vez só os meses que você editou agora.</p>
        <button type="button" class="btn ghost" id="salvar-todos-grade">Salvar alterações</button>
      </div>`;
  }

  // Versão compacta de campoHtml — para uma célula de tabela (sem <label>,
  // sem o wrapper "field"). Usada pelas linhas da Grade do Ano.
  function campoHtmlCompacto(campo, valoresAtuais) {
    const v = valoresAtuais ? valoresAtuais[campo.key] : undefined;
    if (campo.tipo === "select") {
      return `<select data-key="${campo.key}">${campo.opcoes.map((o) => `<option value="${o.value}" ${((v ?? campo.padrao) === o.value) ? "selected" : ""}>${o.label}</option>`).join("")}</select>`;
    }
    // Campo numérico é <input type="text"> de propósito: em type="number" o
    // navegador descarta a vírgula enquanto a pessoa digita e "86,5" vira
    // "865". A conversão para número acontece na leitura (parseNumeroLocal),
    // que entende tanto vírgula quanto ponto.
    const inputType = campo.tipo === "text" ? "text" : "text";
    const modoTeclado = campo.tipo === "integer" ? "numeric" : campo.tipo === "text" ? "text" : "decimal";
    return `<input type="${inputType}" inputmode="${modoTeclado}" data-key="${campo.key}" value="${v ?? ""}" />`;
  }

  function renderFormularioAtualizar(ind, competencia) {
    const doc = (State.competenciasPorIndicador[ind.id] || {})[competencia];
    const existia = !!doc;
    const camposHtml = ind.camposEntrada.map((c) => campoHtml(c, doc ? doc.entradas : {})).join("");
    return `
      <div class="status-line">${existia
        ? `Já existe valor vigente para ${competenciaLabel(competencia)} (${doc.qtdAtualizacoes || 1}ª gravação, última em ${fmtDataHora(doc.atualizadoEm)} por ${nomeUsuario(doc.atualizadoPor)}). Salvar aqui registra uma <strong>correção</strong>.`
        : `Nenhum valor lançado ainda para ${competenciaLabel(competencia)} — este será o <strong>lançamento inicial</strong>.`}</div>
      <form id="form-lanc" data-comp="${competencia}">
        ${camposHtml}
        <div class="field"><label for="f-motivo">Motivo da atualização (opcional)</label>
          <input type="text" id="f-motivo" placeholder="ex.: pendência resolvida, correção de digitação…" /></div>
        <div id="preview-calc"></div>
        <div style="display:flex;gap:10px;margin-top:6px">
          <button type="submit" class="btn primary" id="btn-salvar">Salvar</button>
          <button type="button" class="btn ghost" id="btn-lupa-preview">Ver detalhamento do indicador</button>
        </div>
      </form>`;
  }

  function campoHtml(campo, valoresAtuais) {
    const v = valoresAtuais ? valoresAtuais[campo.key] : undefined;
    const mostrarAttr = campo.mostrarSe ? ` data-mostrar-se='${JSON.stringify(campo.mostrarSe)}'` : "";
    if (campo.tipo === "tabela") {
      const linhas = Array.isArray(v) ? v : [];
      return `<div class="field" style="flex-basis:100%" data-campo="${campo.key}" data-tipo="tabela"${mostrarAttr}>
        <label>${campo.label}</label>
        <table class="tabela-input" data-subcampos='${JSON.stringify(campo.subcampos)}'>
          <thead><tr>${campo.subcampos.map((s) => `<th>${s.label}</th>`).join("")}<th></th></tr></thead>
          <tbody>${linhas.map((l) => linhaTabela(campo.subcampos, l)).join("")}</tbody>
        </table>
        <button type="button" class="add-row" data-add-linha="${campo.key}">+ adicionar linha</button>
      </div>`;
    }
    if (campo.tipo === "select") {
      return `<div class="field" data-campo="${campo.key}"${mostrarAttr}><label>${campo.label}</label>
        <select data-key="${campo.key}">${campo.opcoes.map((o) => `<option value="${o.value}" ${((v ?? campo.padrao) === o.value) ? "selected" : ""}>${o.label}</option>`).join("")}</select></div>`;
    }
    const modoTeclado = campo.tipo === "integer" ? "numeric" : campo.tipo === "text" ? "text" : "decimal";
    return `<div class="field" data-campo="${campo.key}"${mostrarAttr}><label>${campo.label}${campo.obrigatorio ? " *" : ""}</label>
      <input type="text" inputmode="${modoTeclado}" data-key="${campo.key}" value="${v ?? ""}" /></div>`;
  }

  function linhaTabela(subcampos, valores) {
    return `<tr>${subcampos.map((s) => `<td><input type="text" inputmode="${s.tipo === "number" ? "decimal" : "text"}" data-sub="${s.key}" value="${(valores && valores[s.key]) ?? ""}" /></td>`).join("")}<td><button type="button" class="rm" data-rm-linha>✕</button></td></tr>`;
  }

  function lerEntradasDoFormulario(ind) {
    const entradas = {};
    ind.camposEntrada.forEach((campo) => {
      const wrap = $(`[data-campo="${campo.key}"]`, $("#form-lanc"));
      if (!wrap) return;
      if (campo.tipo === "tabela") {
        const linhas = [];
        $$("tbody tr", wrap).forEach((tr) => {
          const obj = {};
          let algum = false;
          $$("input[data-sub]", tr).forEach((inp) => {
            const sub = campo.subcampos.find((s) => s.key === inp.dataset.sub);
            let val = inp.value;
            if (val !== "" && sub.tipo === "number") val = parseNumeroLocal(val);
            if (val !== "") algum = true;
            obj[inp.dataset.sub] = val === "" ? undefined : val;
          });
          if (algum) linhas.push(obj);
        });
        entradas[campo.key] = linhas;
      } else {
        const input = $("input,select", wrap);
        if (!input) return;
        let val = input.value;
        if (val === "") { return; }
        if (campo.tipo === "number" || campo.tipo === "integer") val = parseNumeroLocal(val);
        entradas[campo.key] = val;
      }
    });
    return entradas;
  }

  function atualizarPreview(ind) {
    const entradas = lerEntradasDoFormulario(ind);
    const { valido, erros } = E.validarConsistencia(ind, entradas);
    const box = $("#preview-calc");
    const btn = $("#btn-salvar");
    if (!valido) {
      box.innerHTML = `<div class="preview-box"><div class="plabel">Corrija antes de salvar</div><div class="perros">${erros.map((e) => `• ${e}`).join("<br/>")}</div></div>`;
      if (btn) btn.disabled = true;
      return;
    }
    const { resultado, detalhes } = E.calcularResultadoCompetencia(ind, entradas);
    const status = E.calcularSaude(ind, resultado, detalhes);
    box.innerHTML = `<div class="preview-box">
      <div class="plabel">Resultado calculado (motor: ${ind.calc.motor})</div>
      <div class="pval num">${formatarResultado(resultado, ind.unidade)} ${pillStatus(status)}</div>
      ${detalhes ? `<div class="pdetail">${detalhes.map((d) => `${d.label}: <strong class="num">${d.valor ?? "—"}</strong>`).join(" · ")}</div>` : ""}
    </div>`;
    if (btn) btn.disabled = resultado === null && ind.camposEntrada.some((c) => c.obrigatorio);
  }

  // ------------------------------------------------------------- indicadores
  function viewIndicadores() {
    return `<div class="ind-table-wrap"><table class="ind-table">
      <thead><tr><th>ID</th><th>Indicador</th><th>Área</th><th>Categoria</th><th>Responsável</th><th>Unidade</th><th>Motor</th><th>Direção saúde</th><th>Meta</th><th>Status</th><th></th></tr></thead>
      <tbody>${State.indicadores.map((ind) => `
        <tr>
          <td class="mono">${ind.id}</td>
          <td><strong>${ind.nome}</strong>${ind.proposto ? '<div style="color:var(--amarelo);font-size:11px">proposto/inativo</div>' : ""}</td>
          <td>${nomeArea(ind.area)}</td>
          <td>${nomeCategoria(ind.categoria)}</td>
          <td>${ind.responsavelId ? nomeUsuario(ind.responsavelId) : '<span style="color:var(--muted)">—</span>'}</td>
          <td class="mono">${ind.unidade}</td>
          <td>${ind.calc.motor}</td>
          <td>${ind.saude.tipo}</td>
          <td class="mono">${ind.meta ?? "—"}</td>
          <td>${ind.ativo ? '<span class="status-pill verde"><span class="dot"></span>ativo</span>' : '<span class="status-pill sem_informacao"><span class="dot"></span>inativo</span>'}</td>
          <td><button class="editbtn" data-edit="${ind.id}">Editar</button></td>
        </tr>`).join("")}</tbody>
    </table></div>`;
  }

  function drawerEditarIndicador(ind) {
    const lim = ind.saude.limites || {};
    const temLimites = ind.saude.tipo === "maior_melhor" || ind.saude.tipo === "menor_melhor";
    return `<div class="overlay" id="overlay-edit"><div class="drawer">
      <div class="dhead"><div><div class="id">${ind.id}</div><h2>${ind.nome}</h2></div><button class="close-btn" id="fechar-edit">✕</button></div>
      <form id="form-edit">
        <div class="form-row">
          <div class="field"><label>Ativo no One Page</label><select id="e-ativo"><option value="1" ${ind.ativo ? "selected" : ""}>Sim</option><option value="0" ${!ind.ativo ? "selected" : ""}>Não</option></select></div>
          <div class="field"><label>Meta/referência</label><input type="text" inputmode="decimal" id="e-meta" value="${textoNumero(ind.meta)}"/></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Responsável pelo indicador</label>
            <select id="e-responsavel">
              <option value="">— Nenhum —</option>
              ${State.usuarios.filter((u) => u.ativo !== false || u.id === ind.responsavelId).map((u) => `<option value="${u.id}" ${u.id === ind.responsavelId ? "selected" : ""}>${u.nome}${u.ativo === false ? " (inativo)" : ""}</option>`).join("")}
            </select>
          </div>
        </div>
        <p class="hint" style="margin:-6px 0 12px">A lista vem do cadastro de Responsáveis — não é possível digitar um nome livre. <button type="button" class="add-row" id="ir-novo-responsavel" style="padding:0">+ cadastrar novo responsável</button></p>
        ${temLimites ? `<div class="form-row">
          <div class="field"><label>Limite verde (${ind.saude.tipo === "maior_melhor" ? "≥" : "≤"})</label><input type="text" inputmode="decimal" id="e-verde" value="${textoNumero(lim.verde)}"/></div>
          <div class="field"><label>Limite amarelo (${ind.saude.tipo === "maior_melhor" ? "≥" : "≤"})</label><input type="text" inputmode="decimal" id="e-amarelo" value="${textoNumero(lim.amarelo)}"/></div>
        </div>
        <p class="hint" style="margin:-6px 0 12px">Abaixo/acima desses limites, o indicador é classificado como vermelho. Regra de saúde é dado configurável — nunca fixa no código.</p>` : `<p class="hint">Este indicador usa regra de saúde do tipo "${ind.saude.tipo}", sem limites numéricos simples de configurar aqui.</p>`}
        <button type="submit" class="btn primary">Salvar configuração</button>
      </form>
    </div></div>`;
  }

  // ------------------------------------------------------------- responsáveis
  // "Responsável" não é uma entidade separada — é qualquer registro da
  // tabela usuarios (ver seed.js/db.js). Esta tela é a administração dessa
  // tabela. Hoje o cadastro é manual (nome + e-mail); quando o login via
  // Microsoft Entra ID for ligado na versão publicada, o campo `entraId`
  // passa a identificar a pessoa e evita duplicar cadastro — o resto
  // (perfil, ativo, vínculo com indicadores) continua igual.
  function viewResponsaveis() {
    const contagem = {};
    State.indicadores.forEach((ind) => { if (ind.responsavelId) contagem[ind.responsavelId] = (contagem[ind.responsavelId] || 0) + 1; });
    return `
      <div class="status-line">👤 <strong>Responsáveis</strong> = a mesma tabela de usuários do sistema — evita cadastro duplicado quando o login corporativo (Microsoft Entra ID) for ligado na versão publicada. Hoje o vínculo com a conta Microsoft (<span class="mono">entraId</span>) fica em branco e é preenchido automaticamente no primeiro acesso de cada pessoa.</div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn primary" id="novo-responsavel">+ Novo responsável</button></div>
      <div class="ind-table-wrap"><table class="ind-table">
        <thead><tr><th>Nome</th><th>E-mail corporativo</th><th>Perfil</th><th>Conta Microsoft (Entra ID)</th><th>Indicadores vinculados</th><th>Status</th><th></th></tr></thead>
        <tbody>${State.usuarios.map((u) => `
          <tr>
            <td><strong>${u.nome}</strong></td>
            <td class="mono" style="font-size:12px">${u.email || "—"}</td>
            <td>${PERFIL_LABEL[u.perfil] || u.perfil || "—"}</td>
            <td>${u.entraId ? '<span class="status-pill verde"><span class="dot"></span>vinculada</span>' : '<span class="status-pill sem_informacao"><span class="dot"></span>pendente (login simulado)</span>'}</td>
            <td>${contagem[u.id] || 0}</td>
            <td>${u.ativo !== false ? '<span class="status-pill verde"><span class="dot"></span>ativo</span>' : '<span class="status-pill sem_informacao"><span class="dot"></span>inativo</span>'}</td>
            <td><button class="editbtn" data-edit-resp="${u.id}">Editar</button></td>
          </tr>`).join("")}</tbody>
      </table></div>`;
  }

  function drawerEditarUsuario(usuario) {
    const novo = !usuario;
    const u = usuario || { nome: "", email: "", perfil: "operacional", ativo: true };
    return `<div class="overlay" id="overlay-resp"><div class="drawer">
      <div class="dhead"><div><div class="id">${novo ? "Novo responsável" : u.id}</div><h2>${novo ? "Cadastrar responsável" : u.nome}</h2></div><button class="close-btn" id="fechar-resp">✕</button></div>
      <form id="form-resp">
        <div class="form-row">
          <div class="field"><label>Nome completo *</label><input type="text" id="r-nome" value="${u.nome}" required /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>E-mail corporativo *</label><input type="email" id="r-email" value="${u.email || ""}" placeholder="nome@ambarenergia.com.br" required /></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Perfil de acesso</label>
            <select id="r-perfil">
              <option value="operacional" ${u.perfil === "operacional" ? "selected" : ""}>Operacional</option>
              <option value="gestor" ${u.perfil === "gestor" ? "selected" : ""}>Gestor</option>
              <option value="administrador" ${u.perfil === "administrador" ? "selected" : ""}>Administrador</option>
            </select>
          </div>
          <div class="field"><label>Status</label>
            <select id="r-ativo">
              <option value="1" ${u.ativo !== false ? "selected" : ""}>Ativo</option>
              <option value="0" ${u.ativo === false ? "selected" : ""}>Inativo</option>
            </select>
          </div>
        </div>
        <p class="hint">Perfis de acesso (administrador/gestor/operacional) já ficam salvos no cadastro — a aplicação de permissões por perfil entra quando o login corporativo real (Entra ID) estiver ligado.</p>
        <button type="submit" class="btn primary">${novo ? "Cadastrar responsável" : "Salvar alterações"}</button>
      </form>
    </div></div>`;
  }

  // ------------------------------------------------------------- histórico
  function viewHistorico() {
    const idSel = State.filtros.histInd || "";
    const eventos = idSel ? (State.historicoCache[idSel] || []) : Object.entries(State.historicoCache).flatMap(([id, evs]) => evs.map((e) => ({ ...e, indicadorId: id }))).sort((a, b) => b.ts.localeCompare(a.ts));
    return `<div class="filterbar hist-filterbar">
        <label>Indicador<select id="h-ind"><option value="">Todos (carregados)</option>${indicadoresVisiveis().map((i) => `<option value="${i.id}" ${idSel === i.id ? "selected" : ""}>${i.id} — ${i.nome}</option>`).join("")}</select></label>
        <button class="btn ghost" id="h-carregar-todos">Carregar histórico de todos</button>
      </div>
      ${eventos.length === 0 ? `<div class="empty-state"><div class="big">🕓</div>Nenhum evento carregado ainda. Selecione um indicador ou clique em "Carregar histórico de todos".</div>` : `
      <table class="hist-full"><thead><tr><th>Data/hora</th><th>Indicador</th><th>Competência</th><th>Tipo</th><th>Usuário</th><th>Valor anterior → novo</th><th>Motivo</th></tr></thead>
      <tbody>${eventos.slice(0, 300).map((e) => `<tr>
        <td>${fmtDataHora(e.ts)}</td>
        <td>${e.indicadorId || idSel}</td>
        <td>${competenciaLabel(e.competencia)}</td>
        <td class="tipo"><span class="tipo-chip ${e.tipoEvento}">${e.tipoEvento === "lancamento_inicial" ? "Lançamento inicial" : "Correção/atualização"}</span></td>
        <td>${nomeUsuario(e.usuario)}</td>
        <td style="font-size:11px">${resumoValores(e.valorAnterior)} → ${resumoValores(e.valorNovo)}</td>
        <td class="motivo">${e.motivo || "—"}</td>
      </tr>`).join("")}</tbody></table>`}`;
  }

  function resumoValores(v) {
    if (!v) return "<em>—</em>";
    try { return JSON.stringify(v).slice(0, 60).replace(/[{}"]/g, ""); } catch (e) { return "—"; }
  }

  // ------------------------------------------------------------- lupa
  function drawerLupa(ind) {
    const competenciasPeriodo = competenciasDoPeriodo(State.periodo || "6m", State.competenciaFoco);
    const v = visaoIndicadorPeriodo(ind, competenciasPeriodo);
    const hist = State.historicoCache[ind.id];
    const s = ind.saude;
    const compReferencia = v.ultimaComDado || State.competenciaFoco;
    return `<div class="overlay" id="overlay-lupa"><div class="drawer">
      <div class="dhead"><div><div class="id">${ind.id} · ${nomeArea(ind.area)} / ${nomeCategoria(ind.categoria)}</div><h2>${ind.nome}</h2></div><button class="close-btn" id="fechar-lupa">✕</button></div>

      <p class="periodo-label" style="margin:-4px 0 0"><span class="tri"></span> ${rotuloPeriodoTexto(competenciasPeriodo)}</p>
      <div class="resultado-row"><span class="resultado num">${formatarResultado(v.resultadoCard, v.unidadeCard)}</span>${pillStatus(v.status)}</div>

      <div class="chart-wrap">${svgSparkline(v.serieOrdenadaCompleta, { w: 480, h: 110, statusColor: corStatus(v.status), labels: true })}</div>

      <div class="dsection"><h4>O que mede</h4><p>${ind.descricao}</p></div>
      <div class="dsection"><h4>Regra de negócio</h4><p>${ind.regraNegocio}</p></div>
      <div class="dsection"><h4>Fórmula</h4><p>${ind.formula}</p><p class="hint" style="margin:4px 0 0">Tipo de cálculo (motor): <span class="mono">${ind.calc.motor}</span>${ind.calc.acumulativo ? " · acumulativo no ano" : ""}</p>${v.detalhes ? `<p class="mono" style="font-size:12px">${v.detalhes.map((d) => `${d.label}=${d.valor ?? "—"}`).join(" · ")}</p>` : ""}</div>
      <div class="dsection"><h4>Dados de entrada (${compReferencia ? competenciaLabel(compReferencia) : "—"})</h4>
        ${v.docAtual ? `<dl class="kv">${ind.camposEntrada.filter((c) => c.tipo !== "tabela").map((c) => `<dt>${c.label}</dt><dd>${formatCampoValor(v.docAtual.entradas[c.key])}</dd>`).join("")}</dl>` : `<p>Sem lançamento nesta janela.</p>`}
      </div>
      <div class="dsection"><h4>Responsável pelo indicador</h4>${respostaLupaResponsavel(ind)}</div>
      <div class="dsection"><h4>Período considerado</h4><p>${ind.periodoConsiderado}</p></div>
      <div class="dsection"><h4>Forma de consolidação</h4><p>${ind.formaConsolidacao}</p></div>
      <div class="dsection"><h4>Regra de saúde</h4><p>Tipo: <strong>${s.tipo}</strong>${s.limites ? ` · Verde ${s.tipo === "maior_melhor" ? "≥" : "≤"} ${s.limites.verde ?? "—"} · Amarelo ${s.tipo === "maior_melhor" ? "≥" : "≤"} ${s.limites.amarelo ?? "—"}` : ""}${ind.meta !== undefined && ind.meta !== null ? ` · Meta: ${ind.meta}${ind.unidade}` : ""}</p></div>
      ${ind.calc.acumulativo && v.derivado ? `<div class="dsection"><h4>${ind.id === "ADM-024" ? "Consolidado" : "Acumulado"}</h4><p class="mono">${formatarResultado(v.derivado.valor, ind.unidade)}</p></div>` : ""}
      ${ind.calc.motor === "comparativo_proporcional_anual" && v.derivado && v.derivado.valor ? `<div class="dsection"><h4>Comparação proporcional</h4><p>Período 1 (Jan…): R$ ${Math.round(v.derivado.valor.periodo1).toLocaleString("pt-BR")} · Período 2 (Jul…): R$ ${Math.round(v.derivado.valor.periodo2).toLocaleString("pt-BR")}${v.derivado.valor.completo ? "" : " (período incompleto)"}</p></div>` : ""}

      <div class="dsection"><h4>Histórico mensal</h4>
        <table class="hist-table"><thead><tr><th>Competência</th><th>Resultado</th></tr></thead>
        <tbody>${v.serieOrdenadaCompleta.slice(-12).reverse().map((p) => `<tr><td>${competenciaLabel(p.comp)}</td><td>${formatarResultado(p.valor, ind.unidadeMensal || ind.unidade)}</td></tr>`).join("")}</tbody></table>
      </div>

      <div class="dsection"><h4>Auditoria</h4>
        ${v.docAtual ? `<p>Última atualização: <strong>${fmtDataHora(v.docAtual.atualizadoEm)}</strong> por <strong>${nomeUsuario(v.docAtual.atualizadoPor)}</strong> (${v.docAtual.qtdAtualizacoes || 1}ª gravação da competência).</p>` : "<p>Sem registro.</p>"}
        ${hist ? `<table class="hist-table"><thead><tr><th>Data</th><th>Tipo</th><th>Usuário</th><th>Motivo</th></tr></thead>
          <tbody>${hist.slice(0, 8).map((e) => `<tr><td>${fmtDataHora(e.ts)}</td><td>${e.tipoEvento === "lancamento_inicial" ? "Inicial" : "Correção"}</td><td>${nomeUsuario(e.usuario)}</td><td>${e.motivo || "—"}</td></tr>`).join("")}</tbody></table>`
        : `<button class="btn ghost" id="carregar-hist-lupa" data-ind="${ind.id}">Carregar histórico completo</button>`}
      </div>

      <div style="display:flex;gap:10px"><button class="btn primary" id="ir-atualizar" data-ind="${ind.id}" data-comp="${compReferencia || ""}">Corrigir esta competência</button></div>
    </div></div>`;
  }

  // Formulário completo (com campos-tabela) para UMA competência — usado a
  // partir do botão "+ detalhes" de uma linha da Grade do Ano, para os
  // indicadores que têm detalhamento opcional (ex.: pendências por item).
  function drawerAvancado(ind, comp) {
    return `<div class="overlay" id="overlay-avancado"><div class="drawer">
      <div class="dhead"><div><div class="id">${ind.id} · edição detalhada</div><h2>${competenciaLabel(comp)}</h2></div><button class="close-btn" id="fechar-avancado">✕</button></div>
      ${renderFormularioAtualizar(ind, comp)}
    </div></div>`;
  }

  // ------------------------------------------------ importação em lote ---
  // Um Artifact publicado não pode iniciar downloads (o sandbox do viewer
  // bloqueia isso) e não carregamos biblioteca externa nenhuma para ler
  // planilhas binárias — então o fluxo é todo por texto: gera um "modelo"
  // em TSV (colável direto no Excel/Sheets, que já usam tab como separador
  // de célula ao copiar/colar — evita a confusão de vírgula decimal do
  // pt-BR quebrar um CSV separado por vírgula), a pessoa preenche fora e
  // cola de volta aqui. Só campos simples (não-tabela) entram no modelo.
  function gerarModeloImportacao(escopo, ano) {
    const ativos = indicadoresVisiveis().filter((ind) => (escopo === "meu" ? ind.responsavelId === State.usuarioAtual : true));
    const linhas = [["indicador_id", "indicador_nome", "competencia", "campo", "rotulo", "valor_atual", "valor_novo"]];
    ativos.forEach((ind) => {
      const camposSimples = ind.camposEntrada.filter((c) => c.tipo !== "tabela");
      if (!camposSimples.length) return;
      const mapa = State.competenciasPorIndicador[ind.id] || {};
      for (let m = 1; m <= 12; m++) {
        const comp = `${ano}-${String(m).padStart(2, "0")}`;
        const entradas = (mapa[comp] || {}).entradas || {};
        camposSimples.forEach((c) => {
          const atual = entradas[c.key];
          linhas.push([ind.id, ind.nome, comp, c.key, c.label, atual === undefined || atual === null ? "" : String(atual), ""]);
        });
      }
    });
    return linhas.map((l) => l.map((v) => String(v ?? "").replace(/[\t\r\n]/g, " ")).join("\t")).join("\n");
  }

  // Backup de segurança: TODOS os indicadores (inclusive inativos, para não
  // perder histórico) e TODAS as competências já lançadas — ao contrário do
  // modelo acima, que é só um "espaço em branco" para preencher pendências.
  // Usa o MESMO formato de colunas do modelo de importação, com
  // valor_atual = valor_novo, então essa mesma planilha pode ser colada de
  // volta em "Colar de volta" para restaurar os dados caso algo dê errado.
  // Campos de tabela (detalhamentos) entram serializados em JSON — o
  // processarImportacao sabe reconstituir isso na restauração.
  function gerarBackupCompleto() {
    const linhas = [["indicador_id", "indicador_nome", "competencia", "campo", "rotulo", "valor_atual", "valor_novo"]];
    State.indicadores.slice().sort((a, b) => a.id.localeCompare(b.id)).forEach((ind) => {
      const mapa = State.competenciasPorIndicador[ind.id] || {};
      Object.keys(mapa).sort().forEach((comp) => {
        const entradas = (mapa[comp] || {}).entradas || {};
        ind.camposEntrada.forEach((c) => {
          const v = entradas[c.key];
          if (v === undefined || v === null) return;
          if (c.tipo === "tabela" && (!Array.isArray(v) || !v.length)) return;
          const texto = c.tipo === "tabela" ? JSON.stringify(v) : String(v);
          linhas.push([ind.id, ind.nome, comp, c.key, c.label, texto, texto]);
        });
      });
    });
    return linhas.map((l) => l.map((v) => String(v ?? "").replace(/[\t\r\n]/g, " ")).join("\t")).join("\n");
  }

  // Aceita o que vier: tab (padrão ao colar do Excel/Sheets), ou CSV com
  // vírgula/ponto-e-vírgula caso a pessoa cole um .csv exportado.
  function parseTabelaColada(texto) {
    const linhasBrutas = texto.replace(/^﻿/, "").replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
    if (!linhasBrutas.length) return [];
    const cabecalho = linhasBrutas[0];
    const delim = cabecalho.includes("\t") ? "\t" : (cabecalho.split(";").length >= cabecalho.split(",").length ? ";" : ",");
    const header = cabecalho.split(delim).map((h) => h.trim().toLowerCase());
    return linhasBrutas.slice(1).map((linha) => {
      const partes = linha.split(delim);
      const obj = {};
      header.forEach((h, i) => { obj[h] = (partes[i] ?? "").trim(); });
      return obj;
    });
  }

  // Aceita tanto "84.81" quanto "84,81" (e "1.234,56") — evita que o
  // separador decimal do pt-BR quebre a importação.
  // Mostra o número no campo do jeito que a pessoa escreve (vírgula).
  function textoNumero(v) {
    return v === null || v === undefined ? "" : String(v).replace(".", ",");
  }

  function parseNumeroLocal(str) {
    let s = String(str ?? "").trim();
    if (s === "") return undefined;
    if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
    else if (s.includes(",")) s = s.replace(",", ".");
    const n = Number(s);
    return Number.isNaN(n) ? undefined : n;
  }

  // Agrupa as linhas coladas por (indicador, competência), valida cada
  // grupo contra as regras já existentes (validarConsistencia) e devolve
  // uma prévia — nada é gravado aqui. Linhas com "valor_novo" em branco são
  // ignoradas (significam "sem alteração nesse campo").
  function processarImportacao(linhas) {
    const porGrupo = {};
    linhas.forEach((l) => {
      const indId = l["indicador_id"], comp = l["competencia"], campo = l["campo"], valorNovo = l["valor_novo"];
      if (!indId || !comp || !campo || valorNovo === undefined || valorNovo === "") return;
      const key = `${indId}__${comp}`;
      porGrupo[key] = porGrupo[key] || { indicadorId: indId, competencia: comp, camposTexto: {} };
      porGrupo[key].camposTexto[campo] = valorNovo;
    });
    return Object.values(porGrupo).map((g) => {
      const ind = State.indicadores.find((i) => i.id === g.indicadorId);
      if (!ind) return Object.assign({}, g, { valido: false, mensagem: `Indicador "${g.indicadorId}" não encontrado.` });
      if (!/^\d{4}-\d{2}$/.test(g.competencia)) return Object.assign({}, g, { indicadorNome: ind.nome, valido: false, mensagem: `Competência "${g.competencia}" inválida (use AAAA-MM).` });
      const entradasNovas = {};
      let erroCampo = null;
      Object.entries(g.camposTexto).forEach(([key, valTexto]) => {
        const campoDef = ind.camposEntrada.find((c) => c.key === key);
        if (!campoDef) return;
        if (campoDef.tipo === "tabela") {
          // Só existe nesse formato quando a linha vem de um backup gerado
          // pelo próprio sistema (ver gerarBackupCompleto) — um modelo de
          // preenchimento normal nunca traz texto nessa coluna, então isso
          // não muda o comportamento de uma importação comum.
          try {
            const arr = JSON.parse(valTexto);
            if (Array.isArray(arr)) entradasNovas[key] = arr;
          } catch (e) { /* não é um backup válido para este campo — ignora */ }
          return;
        }
        if (campoDef.tipo === "number" || campoDef.tipo === "integer") {
          const n = parseNumeroLocal(valTexto);
          if (n === undefined) { erroCampo = `Valor não numérico em "${campoDef.label}": "${valTexto}".`; return; }
          entradasNovas[key] = n;
        } else if (campoDef.tipo === "select") {
          if (!campoDef.opcoes.some((o) => o.value === valTexto)) { erroCampo = `Valor inválido em "${campoDef.label}": "${valTexto}".`; return; }
          entradasNovas[key] = valTexto;
        } else {
          entradasNovas[key] = valTexto;
        }
      });
      if (erroCampo) return Object.assign({}, g, { indicadorNome: ind.nome, valido: false, mensagem: erroCampo });
      const docAtual = (State.competenciasPorIndicador[ind.id] || {})[g.competencia];
      const entradas = docAtual ? Object.assign({}, docAtual.entradas, entradasNovas) : entradasNovas;
      const { valido, erros } = E.validarConsistencia(ind, entradas);
      return Object.assign({}, g, {
        indicadorNome: ind.nome, entradas, valido, mensagem: valido ? null : erros[0],
        tipoPrevisto: docAtual ? "correcao" : "lancamento_inicial",
      });
    }).sort((a, b) => (a.indicadorId + a.competencia).localeCompare(b.indicadorId + b.competencia));
  }

  // Grava sequencialmente (nunca em paralelo): o histórico de cada
  // indicador é um único documento lido-e-regravado, então duas gravações
  // simultâneas do MESMO indicador poderiam se sobrescrever.
  async function executarImportacao(preview) {
    let ok = 0, erro = 0;
    for (const item of preview) {
      if (!item.valido) { erro++; continue; }
      await window.Db.salvarCompetencia(item.indicadorId, item.competencia, item.entradas, State.usuarioAtual, "Importação em lote");
      ok++;
    }
    return { ok, erro };
  }

  function fecharImportar() {
    State.importar = { aberto: false, escopo: "todos", ano: null, modoModelo: null, modeloGerado: "", colado: "", preview: null, resultadoFinal: null };
    render();
  }

  function drawerImportar() {
    const st = State.importar;
    const anos = anosDisponiveis();
    const ano = st.ano || anos[0];
    let corpo;
    if (st.resultadoFinal) {
      corpo = `<div class="dsection"><h4>Importação concluída</h4>
        <p>${st.resultadoFinal.ok} competência(s) gravada(s)${st.resultadoFinal.erro ? ` · ${st.resultadoFinal.erro} linha(s) com erro (não gravadas)` : ""}.</p>
        <button type="button" class="btn primary" id="imp-fechar">Fechar</button>
      </div>`;
    } else if (st.preview) {
      const comAlteracao = st.preview.filter((p) => p.valido);
      const comErro = st.preview.filter((p) => !p.valido);
      corpo = `<div class="dsection">
        <h4>Conferir antes de gravar</h4>
        <p>${comAlteracao.length} competência(s) prontas para gravar${comErro.length ? ` · ${comErro.length} com erro (não serão gravadas)` : ""}.</p>
        <div class="tabela-preview-wrap"><table class="hist-table"><thead><tr><th>Indicador</th><th>Competência</th><th>Situação</th></tr></thead>
          <tbody>${st.preview.map((p) => `<tr>
            <td>${p.indicadorId}${p.indicadorNome ? " — " + p.indicadorNome : ""}</td>
            <td>${p.competencia}</td>
            <td>${p.valido ? `<span class="tag-ok">${p.tipoPrevisto === "correcao" ? "correção" : "novo lançamento"}</span>` : `<span class="tag-atencao" title="${p.mensagem}">${p.mensagem}</span>`}</td>
          </tr>`).join("")}</tbody></table></div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button type="button" class="btn primary" id="imp-confirmar" ${comAlteracao.length ? "" : "disabled"}>Confirmar e gravar ${comAlteracao.length} competência(s)</button>
          <button type="button" class="btn ghost" id="imp-voltar">Voltar</button>
        </div>
      </div>`;
    } else {
      corpo = `<div class="dsection dsection-backup">
        <h4>🛟 Backup de segurança</h4>
        <p class="hint">Traz tudo que já foi lançado — todos os indicadores, todos os meses — pronto para copiar e guardar numa planilha (Excel, Google Sheets, Drive). Se algo der errado, cole essa mesma planilha em "Colar de volta" logo abaixo para restaurar os dados.</p>
        <button type="button" class="btn ghost" id="imp-backup">Gerar backup completo para copiar</button>
      </div>
      <div class="dsection">
        <h4>Preencher lançamentos pendentes</h4>
        <div class="form-row" style="margin-bottom:8px">
          <div class="field" style="flex:0 0 110px;min-width:110px"><label for="imp-ano">Ano</label>
            <select id="imp-ano">${anos.map((a) => `<option value="${a}" ${a === ano ? "selected" : ""}>${a}</option>`).join("")}</select></div>
          <div class="field"><label for="imp-escopo">Indicadores</label><select id="imp-escopo">
            <option value="todos" ${st.escopo === "todos" ? "selected" : ""}>Todos os indicadores ativos</option>
            <option value="meu" ${st.escopo === "meu" ? "selected" : ""}>Somente os meus (${nomeUsuario(State.usuarioAtual)})</option>
          </select></div>
        </div>
        <button type="button" class="btn ghost" id="imp-gerar">Gerar modelo para copiar</button>
      </div>
      ${st.modeloGerado ? `<div class="dsection">
        <h4>${st.modoModelo === "backup" ? "Backup gerado" : "Modelo gerado"}</h4>
        <p class="hint">${st.modoModelo === "backup"
          ? "Copie e guarde esta planilha num local seguro. Para restaurar depois, cole o conteúdo inteiro (sem alterar nada) na caixa \"Colar de volta\" e processe."
          : "Copie abaixo, cole numa aba nova do Excel ou Google Sheets, preencha a coluna <strong>valor_novo</strong> (deixe em branco o que não quer alterar) e depois selecione tudo de novo, incluindo o cabeçalho, e copie."}</p>
        <textarea id="imp-modelo" class="mono textarea-modelo" rows="8" readonly>${st.modeloGerado}</textarea>
        <button type="button" class="btn ghost" id="imp-copiar">Copiar</button>
        ${st.modoModelo !== "backup" ? `<p class="hint">Campos de detalhamento (tabela) não entram aqui — continue usando "+ detalhes" na Grade do Ano para esses.</p>` : ""}
      </div>` : ""}
      <div class="dsection">
        <h4>Colar de volta (preenchido ou backup para restaurar)</h4>
        <textarea id="imp-colar" class="mono textarea-modelo" rows="8" placeholder="Cole aqui os dados copiados do Excel/Sheets — já preenchidos, ou um backup para restaurar…">${st.colado || ""}</textarea>
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <button type="button" class="btn primary" id="imp-processar">Processar</button>
          <label class="btn ghost" style="cursor:pointer">Ou escolher um arquivo .csv/.tsv<input type="file" id="imp-arquivo" accept=".csv,.tsv,.txt" style="display:none" /></label>
        </div>
      </div>`;
    }
    return `<div class="overlay" id="overlay-importar"><div class="drawer">
      <div class="dhead"><div><div class="id">Atualização em lote</div><h2>Importar vários meses de uma vez</h2></div><button class="close-btn" id="fechar-importar">✕</button></div>
      ${corpo}
    </div></div>`;
  }

  function respostaLupaResponsavel(ind) {
    const u = ind.responsavelId ? usuarioPorId(ind.responsavelId) : null;
    if (!u) return `<p style="color:var(--muted)">Nenhum responsável definido para este indicador. Defina em Indicadores → Editar.</p>`;
    return `<p><strong>${u.nome}</strong>${u.ativo === false ? ` <span class="status-pill sem_informacao" style="margin-left:4px"><span class="dot"></span>inativo</span>` : ""}<br/><a href="mailto:${u.email}" class="mono" style="font-size:12.5px">${u.email || "—"}</a></p>`;
  }

  function formatCampoValor(v) {
    if (v === undefined || v === null || v === "") return "—";
    if (Array.isArray(v)) return `${v.length} linha(s)`;
    return String(v);
  }

  function renderModais() {
    const root = $("#modais");
    let html = "";
    if (State.lupaAberta) {
      const ind = State.indicadores.find((i) => i.id === State.lupaAberta);
      if (ind) html += drawerLupa(ind);
    }
    if (State.editAberto) {
      const ind = State.indicadores.find((i) => i.id === State.editAberto);
      if (ind) html += drawerEditarIndicador(ind);
    }
    if (State.respEditAberto) {
      const u = State.respEditAberto === "__novo__" ? null : usuarioPorId(State.respEditAberto);
      html += drawerEditarUsuario(u);
    }
    if (State.atualizarSel.modoAvancadoComp) {
      const ind = State.indicadores.find((i) => i.id === State.atualizarSel.indicadorId);
      if (ind) html += drawerAvancado(ind, State.atualizarSel.modoAvancadoComp);
    }
    if (State.importar.aberto) html += drawerImportar();
    root.innerHTML = html;
  }

  // ------------------------------------------------------------- eventos
  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function wireViewEvents() {
    // dashboard filtros
    const fc = $("#f-comp"); if (fc) fc.addEventListener("change", (e) => { State.competenciaFoco = e.target.value; render(); });
    const fp = $("#f-periodo"); if (fp) fp.addEventListener("change", (e) => { State.periodo = e.target.value; render(); });
    const fa = $("#f-area"); if (fa) fa.addEventListener("change", (e) => { State.filtros.area = e.target.value; render(); });
    const fcat = $("#f-cat"); if (fcat) fcat.addEventListener("change", (e) => { State.filtros.categoria = e.target.value; render(); });
    const fresp = $("#f-resp"); if (fresp) fresp.addEventListener("change", (e) => { State.filtros.responsavel = e.target.value; render(); });
    const fs = $("#f-status"); if (fs) fs.addEventListener("change", (e) => { State.filtros.status = e.target.value; render(); });
    const fclear = $("#f-clear"); if (fclear) fclear.addEventListener("click", () => { State.filtros = { area: "", categoria: "", status: "", responsavel: "" }; render(); });
    $$("[data-lupa]").forEach((b) => b.addEventListener("click", () => { State.lupaAberta = b.dataset.lupa; render(); }));
    $$("[data-editar-mes]").forEach((b) => b.addEventListener("click", () => {
      State.atualizarSel = { indicadorId: b.dataset.ind, ano: b.dataset.comp.split("-")[0], focoComp: null, modoAvancadoComp: b.dataset.comp };
      render();
    }));

    // atualizar — seleção de indicador/ano
    const aInd = $("#at-ind");
    if (aInd) aInd.addEventListener("change", (e) => { State.atualizarSel = { indicadorId: e.target.value, ano: State.atualizarSel.ano, focoComp: null, modoAvancadoComp: null }; render(); });
    const aAno = $("#at-ano");
    if (aAno) aAno.addEventListener("change", (e) => { State.atualizarSel.ano = e.target.value; render(); });

    // Grade do Ano — grava campos simples linha a linha (ou "salvar todos"),
    // sem nunca perder o que a pessoa ainda está digitando em outras linhas
    // quando um snapshot ao vivo re-renderiza a tabela (ver rascunhoGrade).
    const gradeTable = $(".grade-ano");
    if (gradeTable) {
      const indId = gradeTable.dataset.ind;
      const indAtual = State.indicadores.find((i) => i.id === indId);

      const registrarRascunho = (tr) => {
        const comp = tr.dataset.comp;
        State.rascunhoGrade[indId] = State.rascunhoGrade[indId] || {};
        const alvo = (State.rascunhoGrade[indId][comp] = State.rascunhoGrade[indId][comp] || {});
        $$("input,select", tr).forEach((el) => { if (el.dataset.key) alvo[el.dataset.key] = el.value; });
      };

      $$("tr.linha-grade", gradeTable).forEach((tr) => aplicarVisibilidadeCondicionalLinha(indAtual, tr));
      gradeTable.addEventListener("input", (e) => {
        const tr = e.target.closest("tr.linha-grade"); if (!tr) return;
        aplicarVisibilidadeCondicionalLinha(indAtual, tr); registrarRascunho(tr);
      });
      gradeTable.addEventListener("change", (e) => {
        const tr = e.target.closest("tr.linha-grade"); if (!tr) return;
        aplicarVisibilidadeCondicionalLinha(indAtual, tr); registrarRascunho(tr);
      });

      const salvarLinha = async (tr) => {
        const comp = tr.dataset.comp;
        const entradasNovas = lerEntradasDaLinha(indAtual, tr);
        if (!Object.keys(entradasNovas).length) return { status: "vazio" };
        const docAtual = (State.competenciasPorIndicador[indId] || {})[comp];
        // Preserva campos-tabela já existentes (editados só pelo modo avançado).
        const entradas = docAtual ? Object.assign({}, docAtual.entradas, entradasNovas) : entradasNovas;
        const { valido, erros } = E.validarConsistencia(indAtual, entradas);
        if (!valido) return { status: "invalido", mensagem: erros[0] };
        const r = await window.Db.salvarCompetencia(indAtual.id, comp, entradas, State.usuarioAtual, "");
        if (State.rascunhoGrade[indId]) delete State.rascunhoGrade[indId][comp];
        return { status: r.tipoEvento };
      };

      gradeTable.addEventListener("click", async (e) => {
        const btnSalvar = e.target.closest(".salvar-linha");
        if (btnSalvar) {
          const tr = btnSalvar.closest("tr");
          btnSalvar.disabled = true; const original = btnSalvar.textContent; btnSalvar.textContent = "Salvando…";
          try {
            const r = await salvarLinha(tr);
            if (r.status === "lancamento_inicial") toast(`${competenciaLabel(tr.dataset.comp)} salvo.`);
            else if (r.status === "correcao") toast(`${competenciaLabel(tr.dataset.comp)} corrigido — recálculo automático aplicado.`);
            else if (r.status === "vazio") toast("Preencha ao menos um campo antes de salvar.");
            else if (r.status === "invalido") toast(r.mensagem || "Não foi possível salvar este mês.");
          } finally { btnSalvar.disabled = false; btnSalvar.textContent = original; }
          return;
        }
        const btnAvancado = e.target.closest(".avancado-linha");
        if (btnAvancado) { State.atualizarSel.modoAvancadoComp = btnAvancado.dataset.comp; render(); }
      });

      const btnSalvarTodos = $("#salvar-todos-grade");
      if (btnSalvarTodos) {
        btnSalvarTodos.addEventListener("click", async () => {
          // Só os meses que a pessoa de fato mexeu nesta sessão (rascunho
          // registrado) — nunca reenviar linhas intocadas só porque já
          // tinham valor vindo do banco, senão cada "Salvar todos" geraria
          // uma "correção" fantasma (sem mudança real) para todo mês já
          // lançado, poluindo a auditoria.
          const comps = Object.keys(State.rascunhoGrade[indId] || {});
          if (!comps.length) { toast("Nenhuma alteração para salvar — edite algum mês primeiro."); return; }
          btnSalvarTodos.disabled = true; const original = btnSalvarTodos.textContent; btnSalvarTodos.textContent = "Salvando…";
          let salvos = 0, comErro = 0;
          for (const comp of comps) {
            const tr = $(`tr[data-comp="${comp}"]`, gradeTable);
            if (!tr) continue;
            const r = await salvarLinha(tr);
            if (r.status === "lancamento_inicial" || r.status === "correcao") salvos++;
            else if (r.status === "invalido") comErro++;
          }
          btnSalvarTodos.disabled = false; btnSalvarTodos.textContent = original;
          delete State.historicoCache[indId];
          toast(salvos ? `${salvos} mês(es) salvo(s)${comErro ? ` · ${comErro} com erro` : ""}.` : "Nenhum mês preenchido para salvar.");
        });
      }

      // Ao vir da lupa ("Corrigir esta competência"), rola até a linha e some
      // com o realce depois de usado — não deve reaparecer em todo re-render.
      if (State.atualizarSel.focoComp) {
        const trFoco = $(`tr[data-comp="${State.atualizarSel.focoComp}"]`, gradeTable);
        if (trFoco) trFoco.scrollIntoView({ block: "center" });
        State.atualizarSel.focoComp = null;
      }
    }

    // Formulário completo (modo avançado / campos-tabela)
    const form = $("#form-lanc");
    if (form) {
      const ind = State.indicadores.find((i) => i.id === State.atualizarSel.indicadorId);
      aplicarVisibilidadeCondicional(ind);
      atualizarPreview(ind);
      form.addEventListener("input", () => { aplicarVisibilidadeCondicional(ind); atualizarPreview(ind); });
      form.addEventListener("change", () => { aplicarVisibilidadeCondicional(ind); atualizarPreview(ind); });
      form.addEventListener("click", (e) => {
        if (e.target.matches("[data-add-linha]")) {
          const key = e.target.dataset.addLinha;
          const wrap = $(`[data-campo="${key}"]`);
          const sub = JSON.parse($("table", wrap).dataset.subcampos);
          $("tbody", wrap).insertAdjacentHTML("beforeend", linhaTabela(sub, {}));
        }
        if (e.target.matches("[data-rm-linha]")) { e.target.closest("tr").remove(); atualizarPreview(ind); }
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const comp = form.dataset.comp;
        const entradas = lerEntradasDoFormulario(ind);
        const { valido } = E.validarConsistencia(ind, entradas);
        if (!valido) return;
        const motivo = $("#f-motivo").value;
        const btn = $("#btn-salvar"); btn.disabled = true; btn.textContent = "Salvando…";
        try {
          const r = await window.Db.salvarCompetencia(ind.id, comp, entradas, State.usuarioAtual, motivo);
          toast(r.tipoEvento === "lancamento_inicial" ? "Lançamento salvo." : "Correção salva — recálculo automático aplicado.");
          delete State.historicoCache[ind.id];
          State.atualizarSel.modoAvancadoComp = null;
          render();
        } finally { btn.disabled = false; btn.textContent = "Salvar"; }
      });
    }
    const btnLupaPreview = $("#btn-lupa-preview");
    if (btnLupaPreview) btnLupaPreview.addEventListener("click", () => { State.lupaAberta = State.atualizarSel.indicadorId; render(); });
    const overlayAvancado = $("#overlay-avancado");
    if (overlayAvancado) {
      overlayAvancado.addEventListener("click", (e) => { if (e.target === overlayAvancado) { State.atualizarSel.modoAvancadoComp = null; render(); } });
      $("#fechar-avancado").addEventListener("click", () => { State.atualizarSel.modoAvancadoComp = null; render(); });
    }

    // importação em lote
    const abrirImportar = $("#abrir-importar");
    if (abrirImportar) abrirImportar.addEventListener("click", () => { State.importar.aberto = true; render(); });
    const overlayImportar = $("#overlay-importar");
    if (overlayImportar) {
      overlayImportar.addEventListener("click", (e) => { if (e.target === overlayImportar) fecharImportar(); });
      $("#fechar-importar").addEventListener("click", fecharImportar);
      const impAno = $("#imp-ano"); if (impAno) impAno.addEventListener("change", (e) => { State.importar.ano = e.target.value; State.importar.modeloGerado = ""; render(); });
      const impEscopo = $("#imp-escopo"); if (impEscopo) impEscopo.addEventListener("change", (e) => { State.importar.escopo = e.target.value; State.importar.modeloGerado = ""; render(); });
      const impGerar = $("#imp-gerar");
      if (impGerar) impGerar.addEventListener("click", () => {
        const anos2 = anosDisponiveis();
        State.importar.ano = State.importar.ano || anos2[0];
        State.importar.modoModelo = "template";
        State.importar.modeloGerado = gerarModeloImportacao(State.importar.escopo, State.importar.ano);
        render();
      });
      const impBackup = $("#imp-backup");
      if (impBackup) impBackup.addEventListener("click", () => {
        State.importar.modoModelo = "backup";
        State.importar.modeloGerado = gerarBackupCompleto();
        render();
      });
      const impCopiar = $("#imp-copiar");
      if (impCopiar) impCopiar.addEventListener("click", async () => {
        const ta = $("#imp-modelo");
        const msg = State.importar.modoModelo === "backup" ? "Backup copiado — cole e guarde numa planilha." : "Modelo copiado — cole no Excel ou Google Sheets.";
        try { await navigator.clipboard.writeText(ta.value); toast(msg); }
        catch (err) { ta.select(); toast("Não deu para copiar automaticamente — o texto já está selecionado, use Ctrl+C."); }
      });
      const impColarArea = $("#imp-colar");
      if (impColarArea) impColarArea.addEventListener("input", (e) => { State.importar.colado = e.target.value; });
      const impArquivo = $("#imp-arquivo");
      if (impArquivo) impArquivo.addEventListener("change", (e) => {
        const f = e.target.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { State.importar.colado = String(reader.result || ""); render(); };
        reader.readAsText(f, "utf-8");
      });
      const impProcessar = $("#imp-processar");
      if (impProcessar) impProcessar.addEventListener("click", () => {
        const texto = ($("#imp-colar") || {}).value || State.importar.colado || "";
        if (!texto.trim()) { toast("Cole os dados preenchidos antes de processar."); return; }
        State.importar.colado = texto;
        const linhas = parseTabelaColada(texto);
        const preview = processarImportacao(linhas);
        if (!preview.length) { toast("Não encontrei nenhuma linha com \"valor_novo\" preenchido."); return; }
        State.importar.preview = preview;
        render();
      });
      const impVoltar = $("#imp-voltar");
      if (impVoltar) impVoltar.addEventListener("click", () => { State.importar.preview = null; render(); });
      const impConfirmar = $("#imp-confirmar");
      if (impConfirmar) impConfirmar.addEventListener("click", async () => {
        impConfirmar.disabled = true; impConfirmar.textContent = "Gravando…";
        const r = await executarImportacao(State.importar.preview);
        State.importar.resultadoFinal = r; State.importar.preview = null;
        Object.keys(State.historicoCache).forEach((k) => delete State.historicoCache[k]);
        render();
      });
      const impFechar = $("#imp-fechar");
      if (impFechar) impFechar.addEventListener("click", fecharImportar);
    }

    // indicadores
    $$("[data-edit]").forEach((b) => b.addEventListener("click", () => { State.editAberto = b.dataset.edit; render(); }));

    // responsáveis
    const novoResp = $("#novo-responsavel");
    if (novoResp) novoResp.addEventListener("click", () => { State.respEditAberto = "__novo__"; render(); });
    $$("[data-edit-resp]").forEach((b) => b.addEventListener("click", () => { State.respEditAberto = b.dataset.editResp; render(); }));

    // histórico
    const hInd = $("#h-ind");
    if (hInd) hInd.addEventListener("change", async (e) => {
      State.filtros.histInd = e.target.value;
      if (e.target.value && !State.historicoCache[e.target.value]) State.historicoCache[e.target.value] = await window.Db.lerHistorico(e.target.value);
      render();
    });
    const hTodos = $("#h-carregar-todos");
    if (hTodos) hTodos.addEventListener("click", async () => {
      for (const ind of indicadoresVisiveis()) State.historicoCache[ind.id] = await window.Db.lerHistorico(ind.id);
      render();
    });

    // lupa / edit overlays
    const overlayLupa = $("#overlay-lupa");
    if (overlayLupa) {
      overlayLupa.addEventListener("click", (e) => { if (e.target === overlayLupa) { State.lupaAberta = null; render(); } });
      $("#fechar-lupa").addEventListener("click", () => { State.lupaAberta = null; render(); });
      const carregarHist = $("#carregar-hist-lupa");
      if (carregarHist) carregarHist.addEventListener("click", async () => {
        State.historicoCache[carregarHist.dataset.ind] = await window.Db.lerHistorico(carregarHist.dataset.ind);
        render();
      });
      const irAtualizar = $("#ir-atualizar");
      if (irAtualizar) irAtualizar.addEventListener("click", () => {
        const comp = irAtualizar.dataset.comp || State.competenciaFoco || window.Db.mesAtualISO();
        State.atualizarSel = { indicadorId: irAtualizar.dataset.ind, ano: comp.split("-")[0], focoComp: comp, modoAvancadoComp: null };
        State.lupaAberta = null; State.view = "atualizar"; render();
      });
    }
    const overlayEdit = $("#overlay-edit");
    if (overlayEdit) {
      overlayEdit.addEventListener("click", (e) => { if (e.target === overlayEdit) { State.editAberto = null; render(); } });
      $("#fechar-edit").addEventListener("click", () => { State.editAberto = null; render(); });
      const irNovoResp = $("#ir-novo-responsavel");
      if (irNovoResp) irNovoResp.addEventListener("click", () => {
        State.editAberto = null; State.respEditAberto = "__novo__"; State.view = "responsaveis"; render();
      });
      $("#form-edit").addEventListener("submit", async (e) => {
        e.preventDefault();
        const ind = State.indicadores.find((i) => i.id === State.editAberto);
        const atualizado = JSON.parse(JSON.stringify(ind));
        atualizado.ativo = $("#e-ativo").value === "1";
        const metaVal = $("#e-meta").value;
        atualizado.meta = metaVal.trim() === "" ? null : parseNumeroLocal(metaVal);
        const respVal = $("#e-responsavel").value;
        atualizado.responsavelId = respVal || null;
        if (atualizado.saude.tipo === "maior_melhor" || atualizado.saude.tipo === "menor_melhor") {
          const vv = $("#e-verde").value, av = $("#e-amarelo").value;
          atualizado.saude.limites = { verde: vv.trim() === "" ? undefined : parseNumeroLocal(vv), amarelo: av.trim() === "" ? undefined : parseNumeroLocal(av) };
        }
        await window.Db.salvarIndicador(atualizado);
        toast("Configuração do indicador salva.");
        State.editAberto = null; render();
      });
    }

    const overlayResp = $("#overlay-resp");
    if (overlayResp) {
      overlayResp.addEventListener("click", (e) => { if (e.target === overlayResp) { State.respEditAberto = null; render(); } });
      $("#fechar-resp").addEventListener("click", () => { State.respEditAberto = null; render(); });
      $("#form-resp").addEventListener("submit", async (e) => {
        e.preventDefault();
        const novo = State.respEditAberto === "__novo__";
        const existente = novo ? null : usuarioPorId(State.respEditAberto);
        const dados = {
          id: existente ? existente.id : undefined,
          entraId: existente ? existente.entraId || null : null,
          nome: $("#r-nome").value.trim(),
          email: $("#r-email").value.trim(),
          perfil: $("#r-perfil").value,
          ativo: $("#r-ativo").value === "1",
        };
        const salvo = await window.Db.salvarUsuario(dados);
        toast(novo ? "Responsável cadastrado." : "Responsável atualizado.");
        if (!State.usuarios.some((u) => u.id === salvo.id)) State.usuarios = State.usuarios.concat([salvo]);
        else State.usuarios = State.usuarios.map((u) => (u.id === salvo.id ? salvo : u));
        if (!State.usuarioAtual) State.usuarioAtual = salvo.id;
        State.respEditAberto = null; render();
      });
    }
  }

  function aplicarVisibilidadeCondicional(ind) {
    if (!ind) return;
    ind.camposEntrada.forEach((c) => {
      if (!c.mostrarSe) return;
      const wrap = $(`[data-campo="${c.key}"]`);
      if (!wrap) return;
      const [depKey, depVal] = Object.entries(c.mostrarSe)[0];
      const depWrap = $(`[data-campo="${depKey}"]`);
      const depInput = depWrap ? $("select,input", depWrap) : null;
      const atual = depInput ? depInput.value : null;
      wrap.hidden = atual !== depVal;
    });
  }

  // Mesma lógica de campos condicionais ("mostrarSe"), mas escopada a UMA
  // linha da Grade do Ano — usar `visibility` (não `hidden`/display:none)
  // preserva a célula na tabela, para as colunas continuarem alinhadas com
  // as outras linhas mesmo quando o campo daquela linha está escondido.
  function aplicarVisibilidadeCondicionalLinha(ind, tr) {
    if (!ind) return;
    ind.camposEntrada.forEach((c) => {
      if (!c.mostrarSe) return;
      const wrap = $(`[data-campo="${c.key}"]`, tr);
      if (!wrap) return;
      const [depKey, depVal] = Object.entries(c.mostrarSe)[0];
      const depWrap = $(`[data-campo="${depKey}"]`, tr);
      const depInput = depWrap ? $("select,input", depWrap) : null;
      const atual = depInput ? depInput.value : null;
      const escondido = atual !== depVal;
      wrap.style.visibility = escondido ? "hidden" : "";
      const campo = $("input,select", wrap);
      if (campo) campo.tabIndex = escondido ? -1 : 0;
    });
  }

  // Lê os campos simples (não-tabela) de UMA linha da Grade do Ano. Campos
  // condicionais escondidos (visibility:hidden) não entram no resultado.
  function lerEntradasDaLinha(ind, tr) {
    const entradas = {};
    ind.camposEntrada.forEach((campo) => {
      if (campo.tipo === "tabela") return;
      const wrap = $(`[data-campo="${campo.key}"]`, tr);
      if (!wrap || wrap.style.visibility === "hidden") return;
      const input = $("input,select", wrap);
      if (!input) return;
      let val = input.value;
      if (val === "") return;
      if (campo.tipo === "number" || campo.tipo === "integer") val = parseNumeroLocal(val);
      entradas[campo.key] = val;
    });
    return entradas;
  }

  // ------------------------------------------------------------- start --
  window.addEventListener("DOMContentLoaded", () => {
    const ready = window.claude && window.claude.hot && window.claude.hot.ready;
    if (ready) window.claude.hot.ready((data) => boot(data));
    else boot(window.claude && window.claude.hot ? window.claude.hot.data : null);
  });

  if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
    window.claude.hot.snapshot(() => ({ view: State.view, filtros: State.filtros, competenciaFoco: State.competenciaFoco, periodo: State.periodo, usuarioAtual: State.usuarioAtual }));
  }
})();
