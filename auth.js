/**
 * AUTH — login real (Supabase Auth) e avisos de erro.
 *
 * No protótipo a "sessão" era simulada: um seletor no topo da tela dizia
 * quem era você. Aqui cada pessoa entra com a própria conta, e o banco só
 * responde para quem está autenticado.
 *
 * A autenticação é provisória (e-mail + senha) e foi desenhada para ser
 * trocada pelo login corporativo da Microsoft (Entra ID) sem recadastro:
 * a identidade de cada pessoa continua sendo a linha dela na tabela
 * `usuarios` — a mesma que alimenta o cadastro de Responsáveis.
 */
(function (global) {
  "use strict";

  let _cliente = null;
  let _usuario = null;

  // Lido ANTES de o cliente do Supabase existir, porque ele limpa o endereço
  // ao processar o link. "type=recovery" = a pessoa chegou pelo link de
  // "esqueci minha senha" (ou pelo link gerado pelo administrador).
  const _urlInicial = (global.location.hash || "") + "&" + (global.location.search || "");
  const VEIO_DE_RECUPERACAO = /type=recovery/.test(_urlInicial);
  const LINK_INVALIDO = /error_code=otp_expired|error=access_denied/.test(_urlInicial);
  const ENDERECO_DO_PAINEL = global.location.origin + global.location.pathname;

  function cliente() {
    if (_cliente) return _cliente;
    const cfg = global.OnePageConfig || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error("Configuração do banco ausente: preencha config.js com a URL e a chave do Supabase.");
    }
    _cliente = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return _cliente;
  }

  async function sessao() {
    const { data } = await cliente().auth.getSession();
    return data && data.session ? data.session : null;
  }

  /**
   * Casa a conta de acesso com o cadastro de Responsáveis. A ligação é
   * feita por `auth_user_id`; na primeira vez, encontra pelo e-mail e
   * grava o vínculo — é isso que faz a coluna "Conta" da tela de
   * Responsáveis passar de pendente para vinculada.
   */
  async function carregarUsuarioDaSessao(sessaoAtual) {
    const sb = cliente();
    const authUserId = sessaoAtual.user.id;
    const email = (sessaoAtual.user.email || "").toLowerCase();

    let { data: linha } = await sb.from("usuarios").select("*").eq("auth_user_id", authUserId).maybeSingle();

    if (!linha && email) {
      const { data: porEmail } = await sb.from("usuarios").select("*").ilike("email", email).maybeSingle();
      if (porEmail) {
        const { data: vinculada } = await sb
          .from("usuarios")
          .update({ auth_user_id: authUserId })
          .eq("id", porEmail.id)
          .select("*");
        linha = (vinculada && vinculada[0]) || porEmail;
      }
    }

    if (!linha) {
      mostrarTelaLogin(
        "Sua conta de acesso funciona, mas este e-mail ainda não está cadastrado como Responsável no sistema. " +
          "Peça a um administrador para incluir você na tela de Responsáveis."
      );
      await sb.auth.signOut();
      return new Promise(function () {});
    }

    if (linha.ativo === false) {
      mostrarTelaLogin("Seu cadastro está inativo. Procure um administrador para reativar seu acesso.");
      await sb.auth.signOut();
      return new Promise(function () {});
    }

    // Chegou pelo link de redefinição, ou o administrador definiu uma senha
    // provisória: antes de entrar no painel, a pessoa escolhe a senha dela.
    const meta = sessaoAtual.user.user_metadata || {};
    if (VEIO_DE_RECUPERACAO || meta.trocar_senha) {
      mostrarTelaNovaSenha(VEIO_DE_RECUPERACAO ? "recuperacao" : "provisoria", linha.nome);
      return new Promise(function () {});
    }

    _usuario = { id: linha.id, nome: linha.nome, email: linha.email, perfil: linha.perfil };
    return _usuario;
  }

  function usuarioLogado() {
    return _usuario;
  }

  async function sair() {
    try {
      await cliente().auth.signOut();
    } catch (e) {
      /* mesmo se falhar, recarregar já devolve para o login */
    }
    global.location.reload();
  }

  // ------------------------------------------------------ tela de login -

  function mostrarTelaLogin(mensagemInicial) {
    if (document.getElementById("tela-login")) return;
    const div = document.createElement("div");
    div.id = "tela-login";
    div.innerHTML = `
      <div class="login-card">
        <div class="login-faixa"></div>
        <img class="login-logo" src="logo.png" alt="Âmbar Energia" />
        <h1>ONE PAGE EXECUTIVO</h1>
        <p class="login-sub">Gestão Administrativa — Âmbar Energia · Regional Centro Sul</p>

        <div class="login-abas">
          <button type="button" data-modo="entrar" class="ativa">Entrar</button>
          <button type="button" data-modo="criar">Primeiro acesso</button>
        </div>

        <form id="form-login">
          <div class="field">
            <label>E-mail</label>
            <input name="email" type="email" required autocomplete="username" placeholder="seu.nome@ambarenergia.com.br" />
          </div>
          <div class="field campo-senha">
            <label>Senha</label>
            <input name="senha" type="password" required minlength="8" autocomplete="current-password" />
          </div>
          <div class="login-erro" hidden></div>
          <button type="submit" class="btn primary login-enviar">Entrar</button>
          <button type="button" class="login-link" id="link-esqueci">Esqueci minha senha</button>
        </form>

        <p class="login-aviso" hidden>
          Acesso por e-mail e senha, disponível para quem já está cadastrado como Responsável no sistema.
          Será substituído pelo login corporativo (Microsoft Entra ID) assim que o TI liberar, sem recadastro.
        </p>
      </div>`;
    document.body.appendChild(div);

    const form = div.querySelector("#form-login");
    const caixaErro = div.querySelector(".login-erro");
    const botao = div.querySelector(".login-enviar");
    const aviso = div.querySelector(".login-aviso");
    const campoSenha = div.querySelector(".campo-senha");
    const linkEsqueci = div.querySelector("#link-esqueci");
    let modo = "entrar";

    function mensagem(texto, ok) {
      caixaErro.textContent = texto;
      caixaErro.classList.toggle("ok", !!ok);
      caixaErro.hidden = false;
    }

    function trocarModo(novo) {
      modo = novo;
      div.querySelectorAll(".login-abas button").forEach((o) => o.classList.toggle("ativa", o.dataset.modo === modo));
      const recuperar = modo === "recuperar";
      campoSenha.hidden = recuperar;
      form.senha.required = !recuperar;
      botao.textContent = modo === "entrar" ? "Entrar" : modo === "criar" ? "Criar acesso e entrar" : "Enviar link de redefinição";
      linkEsqueci.textContent = recuperar ? "Voltar para o login" : "Esqueci minha senha";
      aviso.hidden = modo !== "criar";
      caixaErro.hidden = true;
    }

    if (mensagemInicial) mensagem(mensagemInicial);
    else if (LINK_INVALIDO) {
      mensagem("O link de redefinição expirou ou já foi usado. Peça um novo em \"Esqueci minha senha\" ou com o administrador.");
    }

    div.querySelectorAll(".login-abas button").forEach((b) => {
      b.addEventListener("click", () => trocarModo(b.dataset.modo));
    });
    linkEsqueci.addEventListener("click", () => trocarModo(modo === "recuperar" ? "entrar" : "recuperar"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const senha = form.senha.value;
      caixaErro.hidden = true;
      botao.disabled = true;
      const original = botao.textContent;
      botao.textContent = "Aguarde…";
      try {
        const sb = cliente();
        if (modo === "recuperar") {
          const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: ENDERECO_DO_PAINEL });
          if (r.error) throw r.error;
          // Mensagem neutra de propósito: não revela se o e-mail tem cadastro.
          mensagem("Se este e-mail tiver acesso ao painel, você vai receber um link para criar uma nova senha. Confira também a caixa de spam.", true);
          return;
        }
        const resposta =
          modo === "entrar"
            ? await sb.auth.signInWithPassword({ email: email, password: senha })
            : await sb.auth.signUp({ email: email, password: senha });
        if (resposta.error) throw resposta.error;
        if (modo === "criar" && resposta.data && !resposta.data.session) {
          caixaErro.textContent = "Acesso criado. Confirme o e-mail que acabamos de enviar e depois entre normalmente.";
          caixaErro.hidden = false;
          return;
        }
        global.location.reload();
      } catch (erro) {
        caixaErro.textContent = traduzirErroLogin(erro, modo);
        caixaErro.hidden = false;
      } finally {
        botao.disabled = false;
        botao.textContent = original;
      }
    });
  }

  function traduzirErroLogin(erro, modo) {
    const msg = (erro && erro.message) || String(erro);
    if (/Invalid login credentials/i.test(msg)) return "E-mail ou senha incorretos.";
    if (/banned/i.test(msg)) return "Seu acesso está bloqueado. Procure um administrador do painel.";
    if (/rate limit|too many|security purposes/i.test(msg)) {
      return "Muitas tentativas em pouco tempo. Aguarde alguns minutos ou peça ao administrador um link de redefinição.";
    }
    if (/should be different/i.test(msg)) return "A nova senha precisa ser diferente da senha atual.";
    if (/Email not confirmed/i.test(msg)) return "Confirme o e-mail de acesso antes de entrar.";
    if (/already registered|User already/i.test(msg)) return "Este e-mail já tem acesso criado — use a aba Entrar.";
    if (/Password should be/i.test(msg)) return "A senha precisa ter pelo menos 8 caracteres.";
    if (/não está cadastrado|not allowed/i.test(msg)) {
      return "Este e-mail ainda não está cadastrado como Responsável no sistema. Peça a um administrador para incluí-lo.";
    }
    if (/Failed to fetch|NetworkError/i.test(msg)) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
    if (modo === "recuperar") return `Não foi possível enviar o link: ${msg}`;
    if (modo === "nova-senha") return `Não foi possível salvar a nova senha: ${msg}`;
    return modo === "entrar" ? `Não foi possível entrar: ${msg}` : `Não foi possível criar o acesso: ${msg}`;
  }

  // ------------------------------------------- definir nova senha -------
  // Aparece em dois casos: a pessoa abriu o link de "esqueci minha senha",
  // ou o administrador definiu uma senha provisória para ela.

  function mostrarTelaNovaSenha(motivo, nome) {
    if (document.getElementById("tela-login")) return;
    const div = document.createElement("div");
    div.id = "tela-login";
    const titulo = motivo === "recuperacao" ? "Criar nova senha" : "Troque sua senha provisória";
    const texto =
      motivo === "recuperacao"
        ? "Escolha uma nova senha para entrar no painel."
        : "Sua senha foi definida por um administrador. Escolha uma senha pessoal para continuar.";
    div.innerHTML = `
      <div class="login-card">
        <div class="login-faixa"></div>
        <img class="login-logo" src="logo.png" alt="Âmbar Energia" />
        <h1>${titulo}</h1>
        <p class="login-sub">Olá, ${String(nome || "").replace(/[<>&]/g, "")}. ${texto}</p>
        <form id="form-nova-senha">
          <div class="field">
            <label>Nova senha</label>
            <input name="senha" type="password" required minlength="8" autocomplete="new-password" />
          </div>
          <div class="field">
            <label>Repita a nova senha</label>
            <input name="confirmacao" type="password" required minlength="8" autocomplete="new-password" />
          </div>
          <p class="login-aviso" style="margin:0 0 10px">Mínimo de 8 caracteres. Evite reaproveitar senhas de outros sistemas.</p>
          <div class="login-erro" hidden></div>
          <button type="submit" class="btn primary login-enviar">Salvar senha e entrar</button>
          <button type="button" class="login-link" id="nova-senha-sair">Sair</button>
        </form>
      </div>`;
    document.body.appendChild(div);

    const form = div.querySelector("#form-nova-senha");
    const caixaErro = div.querySelector(".login-erro");
    const botao = div.querySelector(".login-enviar");
    div.querySelector("#nova-senha-sair").addEventListener("click", sair);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      caixaErro.hidden = true;
      if (form.senha.value !== form.confirmacao.value) {
        caixaErro.textContent = "As duas senhas não são iguais.";
        caixaErro.hidden = false;
        return;
      }
      botao.disabled = true;
      botao.textContent = "Aguarde…";
      try {
        const r = await cliente().auth.updateUser({ password: form.senha.value, data: { trocar_senha: false } });
        if (r.error) throw r.error;
        global.history.replaceState(null, "", ENDERECO_DO_PAINEL);
        global.location.reload();
      } catch (erro) {
        caixaErro.textContent = traduzirErroLogin(erro, "nova-senha");
        caixaErro.hidden = false;
        botao.disabled = false;
        botao.textContent = "Salvar senha e entrar";
      }
    });
  }

  // --------------------------------------------------- avisos de erro ---
  // O app grava com try/finally e não trata erro de gravação. Sem isto, uma
  // falha ao salvar passaria despercebida: o botão voltaria ao normal e
  // ninguém saberia que nada foi gravado.

  function avisar(mensagem) {
    const t = document.createElement("div");
    t.className = "toast toast-erro";
    t.textContent = mensagem;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 7000);
  }

  global.addEventListener("unhandledrejection", (e) => {
    const motivo = e.reason;
    avisar((motivo && motivo.message) || "Algo deu errado e a operação não foi concluída.");
  });

  global.Auth = {
    cliente: cliente,
    sessao: sessao,
    carregarUsuarioDaSessao: carregarUsuarioDaSessao,
    usuarioLogado: usuarioLogado,
    mostrarTelaLogin: mostrarTelaLogin,
    sair: sair,
    avisar: avisar,
  };
})(window);
