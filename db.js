/**
 * DB — camada de acesso ao banco de dados (Supabase / PostgreSQL).
 *
 * Esta é a ÚNICA peça diferente da versão que rodava dentro do Artifact.
 * O contrato público (as 20 funções em `global.Db`, mais abaixo) é o mesmo,
 * então `app.js` e `engines.js` continuam exatamente como estavam — nenhuma
 * tela, cor, texto ou regra de cálculo foi reescrita.
 *
 * O que mudou por dentro: antes os dados viviam no banco embutido do
 * Artifact (coleções/documentos aninhados); agora vivem em tabelas reais no
 * Postgres, compartilhadas por todo mundo e protegidas por login.
 *
 *   coleção do Artifact                    tabela no Postgres
 *   -----------------------------------    ----------------------------
 *   areas/{id}                             areas
 *   categorias/{id}                        categorias
 *   usuarios/{id}                          usuarios
 *   indicadores/{id}                       indicadores
 *   indicadores/{id}/competencias/{aaaa-mm} registros_indicador
 *   indicadores/{id}/historico/log         historico_alteracoes (1 linha por evento)
 *
 * Como no protótipo, "resultado" e "status" NUNCA são armazenados — são
 * sempre recalculados a partir de "entradas" na hora da leitura
 * (ver engines.js). É isso que mantém o reprocessamento automático.
 */
(function (global) {
  "use strict";

  let _sb = null;
  let _ready = false;
  let _usuarioSessao = null;

  // ------------------------------------------------ conversão de formato -
  // O app fala camelCase (indicador.camposEntrada); o Postgres fala
  // snake_case (campos_entrada). A tradução acontece só aqui.

  function num(v) {
    return v === null || v === undefined || v === "" ? null : Number(v);
  }

  function indicadorDaLinha(r) {
    return {
      id: r.id,
      nome: r.nome,
      area: r.area_id,
      categoria: r.categoria_id,
      unidade: r.unidade,
      unidadeMensal: r.unidade_mensal,
      ativo: r.ativo,
      responsavelId: r.responsavel_id,
      competenciaInicial: r.competencia_inicial,
      descricao: r.descricao,
      regraNegocio: r.regra_negocio,
      formula: r.formula,
      periodoConsiderado: r.periodo_considerado,
      formaConsolidacao: r.forma_consolidacao,
      observacao: r.observacao,
      meta: num(r.meta),
      saude: r.saude || { tipo: "informativo" },
      calc: r.calc || {},
      camposEntrada: r.campos_entrada || [],
    };
  }

  function linhaDoIndicador(ind) {
    return {
      nome: ind.nome,
      area_id: ind.area,
      categoria_id: ind.categoria,
      unidade: ind.unidade,
      unidade_mensal: ind.unidadeMensal === undefined ? null : ind.unidadeMensal,
      ativo: ind.ativo !== false,
      responsavel_id: ind.responsavelId || null,
      competencia_inicial: ind.competenciaInicial || null,
      descricao: ind.descricao || null,
      regra_negocio: ind.regraNegocio || null,
      formula: ind.formula || null,
      periodo_considerado: ind.periodoConsiderado || null,
      forma_consolidacao: ind.formaConsolidacao || null,
      observacao: ind.observacao || null,
      meta: num(ind.meta),
      saude: ind.saude || { tipo: "informativo" },
      calc: ind.calc || {},
      campos_entrada: ind.camposEntrada || [],
    };
  }

  function usuarioDaLinha(r) {
    return {
      id: r.id,
      nome: r.nome,
      email: r.email,
      perfil: r.perfil,
      ativo: r.ativo,
      // Nesta fase o vínculo real com a conta corporativa ainda não existe
      // (Entra ID entra depois). O que já existe é a conta de acesso que a
      // própria pessoa cria no primeiro acesso — é ela que marca a coluna
      // "Conta Microsoft" como vinculada na tela de Responsáveis.
      entraId: r.entra_id || (r.auth_user_id ? "conta-de-acesso-criada" : null),
    };
  }

  function competenciaDaLinha(r) {
    return {
      competencia: r.competencia_id,
      entradas: r.entradas || {},
      versao: r.versao,
      atualizadoEm: r.atualizado_em,
      atualizadoPor: r.atualizado_por,
      qtdAtualizacoes: r.qtd_atualizacoes,
    };
  }

  function eventoDaLinha(r) {
    return {
      ts: r.ts,
      competencia: r.competencia_id,
      tipoEvento: r.tipo_evento,
      valorAnterior: r.valor_anterior,
      valorNovo: r.valor_novo,
      usuario: r.usuario,
      motivo: r.motivo,
    };
  }

  /** Erro de banco em linguagem de gente — aparece no aviso vermelho da tela. */
  function explicar(erro, acao) {
    const msg = (erro && erro.message) || String(erro);
    if (/row-level security|permission denied/i.test(msg)) {
      return `Sem permissão para ${acao}. Sua sessão pode ter expirado — recarregue a página e entre de novo.`;
    }
    if (/duplicate key|already exists/i.test(msg)) return `Já existe um registro igual (${acao}).`;
    if (/violates foreign key/i.test(msg)) return `Referência inválida ao ${acao} (indicador ou competência inexistente).`;
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Sem conexão com o banco de dados. Verifique a internet e tente de novo.";
    return `Não foi possível ${acao}: ${msg}`;
  }

  // ------------------------------------------------------------ init -----

  async function init() {
    _sb = global.Auth.cliente();
    const sessao = await global.Auth.sessao();
    if (!sessao) {
      // Ninguém logado: mostra a tela de login e trava o boot. O login
      // recarrega a página, e aí sim o app sobe com a sessão pronta.
      global.Auth.mostrarTelaLogin();
      return new Promise(function () {});
    }
    _usuarioSessao = await global.Auth.carregarUsuarioDaSessao(sessao);
    _ready = true;
    ligarAtualizacaoAoVoltar();
    return true;
  }

  function disponivel() {
    return _ready && !!_sb;
  }

  /** Nunca é mock: daqui em diante é sempre banco de verdade. */
  function isMock() {
    return false;
  }

  /**
   * No Artifact estas duas funções carregavam o catálogo inicial e
   * consertavam bases antigas. Agora o catálogo mora no banco (foi criado
   * por migração e é a fonte da verdade), então aqui elas não fazem nada —
   * de propósito. A versão antiga do ensureCamposNovos() APAGAVA qualquer
   * indicador fora da lista do seed; se continuasse ativa, apagaria o
   * ADM-026 toda vez que alguém abrisse o sistema.
   */
  async function ensureSeeded() {
    return false;
  }
  async function ensureCamposNovos() {
    return 0;
  }

  function mesAtualISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  /** A pessoa logada, já casada com o cadastro de Responsáveis. */
  function usuarioSessao() {
    return _usuarioSessao;
  }

  // ----------------------------------------------- cadastro (leitura) ----

  async function listarIndicadores() {
    const { data, error } = await _sb.from("indicadores").select("*").order("id");
    if (error) throw new Error(explicar(error, "carregar os indicadores"));
    (data || []).forEach((r) => inicioPorIndicador.set(r.id, r.competencia_inicial || null));
    return (data || []).map(indicadorDaLinha);
  }

  async function listarAreas() {
    const { data, error } = await _sb.from("areas").select("*").order("ordem");
    if (error) throw new Error(explicar(error, "carregar as áreas"));
    return data || [];
  }

  async function listarCategorias() {
    const { data, error } = await _sb.from("categorias").select("*").order("ordem");
    if (error) throw new Error(explicar(error, "carregar as categorias"));
    return data || [];
  }

  // Guarda id -> nome para a auditoria gravar o nome da pessoa (é assim que
  // os lançamentos já existentes no banco estão registrados).
  const nomePorId = new Map();
  const inicioPorIndicador = new Map();

  async function listarUsuarios() {
    const { data, error } = await _sb.from("usuarios").select("*").order("nome");
    if (error) throw new Error(explicar(error, "carregar os responsáveis"));
    (data || []).forEach((u) => nomePorId.set(u.id, u.nome));
    return (data || []).map(usuarioDaLinha);
  }

  /** Converte o id de quem está logado no nome que vai para a auditoria. */
  function nomeParaAuditoria(usuario) {
    if (!usuario) return null;
    if (nomePorId.has(usuario)) return nomePorId.get(usuario);
    if (_usuarioSessao && _usuarioSessao.id === usuario) return _usuarioSessao.nome;
    return usuario;
  }

  // ----------------------------------------------- cadastro (escrita) ----

  async function salvarIndicador(indicador) {
    // O catálogo é fechado: esta tela edita a configuração de um indicador
    // que já existe (ativo, meta, responsável, limites de saúde). Criar ou
    // remover indicador é ato deliberado, feito direto no banco.
    const { data, error } = await _sb
      .from("indicadores")
      .update(linhaDoIndicador(indicador))
      .eq("id", indicador.id)
      .select("id");
    if (error) throw new Error(explicar(error, "salvar a configuração do indicador"));
    if (!data || !data.length) {
      throw new Error(`O indicador ${indicador.id} não foi encontrado no catálogo — nada foi gravado.`);
    }
    await notificarIndicadores();
  }

  async function removerIndicador() {
    throw new Error("O catálogo de indicadores é fechado — não é possível excluir um indicador por aqui.");
  }

  function slugUsuario(nome) {
    return (
      String(nome || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") || "usuario"
    );
  }

  async function salvarUsuario(usuario) {
    const corpo = {
      nome: usuario.nome,
      email: usuario.email || null,
      perfil: usuario.perfil || "operacional",
      ativo: usuario.ativo !== false,
    };

    if (usuario.id) {
      const { data, error } = await _sb.from("usuarios").update(corpo).eq("id", usuario.id).select("*");
      if (error) throw new Error(explicar(error, "salvar o responsável"));
      if (!data || !data.length) throw new Error("O responsável não foi encontrado — nada foi gravado.");
      await notificarIndicadores();
      return usuarioDaLinha(data[0]);
    }

    // Novo: gera um id curto no mesmo padrão do cadastro atual
    // ("erika-lopes", "rafael-fontoura"), com sufixo só se já existir.
    const base = slugUsuario(usuario.nome);
    let id = base;
    for (let tentativa = 2; tentativa < 50; tentativa++) {
      const { data: existe } = await _sb.from("usuarios").select("id").eq("id", id).maybeSingle();
      if (!existe) break;
      id = `${base}-${tentativa}`;
    }
    const { data, error } = await _sb
      .from("usuarios")
      .insert(Object.assign({ id: id }, corpo))
      .select("*");
    if (error) throw new Error(explicar(error, "cadastrar o responsável"));
    await notificarIndicadores();
    return usuarioDaLinha(data[0]);
  }

  // ------------------------------------ competências (fatos canônicos) ---

  async function lerCompetencia(indicadorId, competencia) {
    const { data, error } = await _sb
      .from("registros_indicador")
      .select("*")
      .eq("indicador_id", indicadorId)
      .eq("competencia_id", competencia)
      .maybeSingle();
    if (error) throw new Error(explicar(error, "ler a competência"));
    return data ? competenciaDaLinha(data) : null;
  }

  async function listarCompetencias(indicadorId) {
    const { data, error } = await _sb
      .from("registros_indicador")
      .select("*")
      .eq("indicador_id", indicadorId)
      .order("competencia_id");
    if (error) throw new Error(explicar(error, "listar as competências"));
    const out = {};
    (data || []).forEach((r) => (out[r.competencia_id] = competenciaDaLinha(r)));
    return out;
  }

  /**
   * Grava o valor vigente de uma competência e registra o evento de
   * auditoria. Nunca cria um "novo evento" para o cálculo — apenas
   * sobrescreve o fato vigente; o histórico é só para auditoria.
   */
  async function salvarCompetencia(indicadorId, competencia, entradas, usuario, motivo) {
    // Trava de vigência: vale para qualquer caminho de gravação (grade,
    // matriz, formulário completo, importação em lote).
    const inicio = inicioPorIndicador.get(indicadorId);
    if (inicio && competencia < inicio) {
      throw new Error(
        `${indicadorId} só passou a ser medido a partir de ${inicio.split("-")[1]}/${inicio.split("-")[0]} — não é possível lançar ${competencia.split("-")[1]}/${competencia.split("-")[0]}.`
      );
    }

    const { data: atual, error: erroLeitura } = await _sb
      .from("registros_indicador")
      .select("entradas, versao, qtd_atualizacoes")
      .eq("indicador_id", indicadorId)
      .eq("competencia_id", competencia)
      .maybeSingle();
    if (erroLeitura) throw new Error(explicar(erroLeitura, "ler a competência antes de gravar"));

    const existia = !!atual;
    const agora = new Date().toISOString();
    const assinatura = nomeParaAuditoria(usuario);
    const corpo = {
      indicador_id: indicadorId,
      competencia_id: competencia,
      entradas: entradas,
      versao: (existia ? atual.versao || 0 : 0) + 1,
      atualizado_em: agora,
      atualizado_por: assinatura,
      qtd_atualizacoes: existia ? (atual.qtd_atualizacoes || 1) + 1 : 1,
    };

    const { data: gravado, error } = await _sb
      .from("registros_indicador")
      .upsert(corpo, { onConflict: "indicador_id,competencia_id" })
      .select("id");
    if (error) throw new Error(explicar(error, "salvar o lançamento"));
    if (!gravado || !gravado.length) {
      throw new Error("O lançamento não foi gravado — seu usuário não tem permissão de escrita no banco.");
    }

    const tipoEvento = existia ? "correcao" : "lancamento_inicial";
    const { error: erroHist } = await _sb.from("historico_alteracoes").insert({
      indicador_id: indicadorId,
      competencia_id: competencia,
      ts: agora,
      tipo_evento: tipoEvento,
      valor_anterior: existia ? atual.entradas : null,
      valor_novo: entradas,
      usuario: assinatura,
      motivo: motivo || null,
    });
    // O lançamento já está gravado; falhar só a auditoria não desfaz o
    // lançamento, mas precisa aparecer para alguém corrigir.
    if (erroHist) throw new Error(explicar(erroHist, "registrar o histórico deste lançamento"));

    await notificarCompetencias(indicadorId);
    return { tipoEvento: tipoEvento, versao: corpo.versao };
  }

  // ----------------------------------------------------------- histórico -

  async function lerHistorico(indicadorId) {
    const { data, error } = await _sb
      .from("historico_alteracoes")
      .select("*")
      .eq("indicador_id", indicadorId)
      .order("ts", { ascending: false })
      .limit(500);
    if (error) throw new Error(explicar(error, "carregar o histórico"));
    return (data || []).map(eventoDaLinha); // mais recente primeiro
  }

  // -------------------------------------------- atualização automática ---
  // No Artifact o banco empurrava mudanças sozinho (onSnapshot). Aqui as
  // telas são atualizadas quando: (a) esta aba grava alguma coisa, e (b) a
  // pessoa volta para a aba depois de sair — que é quando pode ter chegado
  // alteração de outra pessoa.

  const ouvintesIndicadores = new Set();
  const ouvintesCompetencias = new Map(); // indicadorId -> Set(cb)
  let loteTimer = null;
  const lotePendente = new Set();

  async function notificarIndicadores() {
    if (!ouvintesIndicadores.size) return;
    const lista = await listarIndicadores();
    ouvintesIndicadores.forEach((cb) => cb(lista));
  }

  async function notificarCompetencias(indicadorId) {
    const set = ouvintesCompetencias.get(indicadorId);
    if (!set || !set.size) return;
    const mapa = await listarCompetencias(indicadorId);
    set.forEach((cb) => cb(mapa));
  }

  /**
   * O app se inscreve em um indicador de cada vez (26 chamadas seguidas no
   * boot). Em vez de 26 consultas, junta todas num piscar de olhos e busca
   * tudo de uma vez só.
   */
  function agendarCarga(indicadorId) {
    lotePendente.add(indicadorId);
    if (loteTimer) return;
    loteTimer = setTimeout(async () => {
      const ids = Array.from(lotePendente);
      lotePendente.clear();
      loteTimer = null;
      const { data, error } = await _sb.from("registros_indicador").select("*").in("indicador_id", ids);
      if (error) {
        global.Auth.avisar(explicar(error, "carregar os lançamentos"));
        return;
      }
      const porIndicador = {};
      ids.forEach((id) => (porIndicador[id] = {}));
      (data || []).forEach((r) => {
        if (!porIndicador[r.indicador_id]) porIndicador[r.indicador_id] = {};
        porIndicador[r.indicador_id][r.competencia_id] = competenciaDaLinha(r);
      });
      ids.forEach((id) => {
        const set = ouvintesCompetencias.get(id);
        if (set) set.forEach((cb) => cb(porIndicador[id] || {}));
      });
    }, 0);
  }

  function watchIndicadores(cb) {
    ouvintesIndicadores.add(cb);
    listarIndicadores()
      .then(cb)
      .catch((e) => global.Auth.avisar(e.message));
    return function () {
      ouvintesIndicadores.delete(cb);
    };
  }

  function watchCompetencias(indicadorId, cb) {
    const set = ouvintesCompetencias.get(indicadorId) || new Set();
    set.add(cb);
    ouvintesCompetencias.set(indicadorId, set);
    agendarCarga(indicadorId);
    return function () {
      set.delete(cb);
    };
  }

  function watchHistorico(indicadorId, cb) {
    lerHistorico(indicadorId)
      .then(cb)
      .catch((e) => global.Auth.avisar(e.message));
    return function () {};
  }

  let ultimaAtualizacao = Date.now();
  function ligarAtualizacaoAoVoltar() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - ultimaAtualizacao < 30000) return;
      ultimaAtualizacao = Date.now();
      notificarIndicadores().catch(() => {});
      Array.from(ouvintesCompetencias.keys()).forEach((id) => agendarCarga(id));
    });
  }

  global.Db = {
    init,
    disponivel,
    isMock,
    ensureSeeded,
    ensureCamposNovos,
    mesAtualISO,
    usuarioSessao,
    listarIndicadores,
    watchIndicadores,
    listarAreas,
    listarCategorias,
    listarUsuarios,
    salvarUsuario,
    salvarIndicador,
    removerIndicador,
    lerCompetencia,
    listarCompetencias,
    watchCompetencias,
    salvarCompetencia,
    lerHistorico,
    watchHistorico,
  };
})(window);
