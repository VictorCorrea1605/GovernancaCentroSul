// Gerenciamento de acessos do One Page Executivo.
//
// Tudo o que mexe em conta de login (criar, bloquear, excluir, trocar senha,
// gerar link de redefinição) precisa da chave secreta do Supabase. A chave
// secreta nunca vai para o navegador, então essas operações passam por esta
// função. Ela só atende administradores ativos, conferidos a cada chamada.
//
// Publicada com verify_jwt = false: a validação do usuário é feita aqui
// dentro (auth.getUser), o que funciona com as chaves novas do Supabase.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function resposta(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

class ErroDeNegocio extends Error {}

function chaveSecreta(): string {
  try {
    const novas = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    if (novas && novas["default"]) return novas["default"];
  } catch (_) { /* cai para a chave legada */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

function chavePublica(): string {
  try {
    const novas = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    if (novas && novas["default"]) return novas["default"];
  } catch (_) { /* cai para a chave legada */ }
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_SB, chaveSecreta(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function slug(nome: string) {
  return (
    String(nome || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "usuario"
  );
}

function validarSenha(senha: unknown) {
  if (typeof senha !== "string" || senha.length < 8) {
    throw new ErroDeNegocio("A senha precisa ter pelo menos 8 caracteres.");
  }
}

function validarRedirect(url: unknown): string | undefined {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return undefined;
  return url;
}

async function todasAsContas() {
  const contas: any[] = [];
  for (let pagina = 1; pagina < 50; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pagina, perPage: 1000 });
    if (error) throw error;
    contas.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return contas;
}

async function cadastro(id: string) {
  const { data, error } = await admin.from("usuarios").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new ErroDeNegocio("Cadastro não encontrado. Atualize a tela e tente de novo.");
  return data;
}

/** Conta de login ligada ao cadastro (por auth_user_id; na falta, pelo e-mail). */
async function contaDoCadastro(linha: any) {
  if (linha.auth_user_id) {
    const { data } = await admin.auth.admin.getUserById(linha.auth_user_id);
    if (data && data.user) return data.user;
  }
  const email = String(linha.email || "").toLowerCase();
  const achada = (await todasAsContas()).find((c) => (c.email || "").toLowerCase() === email);
  if (achada && !linha.auth_user_id) {
    await admin.from("usuarios").update({ auth_user_id: achada.id }).eq("id", linha.id);
  }
  return achada || null;
}

async function registrar(mensagem: string, contexto: Record<string, unknown>) {
  await admin.from("logs_sistema").insert({ nivel: "info", mensagem, contexto });
}

function traduzir(msg: string) {
  if (/último administrador/i.test(msg)) return msg;
  if (/already (been )?registered|already exists/i.test(msg)) return "Já existe uma conta de login com este e-mail.";
  if (/duplicate key.*email/i.test(msg)) return "Já existe um cadastro com este e-mail.";
  if (/Password should|weak/i.test(msg)) return "Senha fraca: use pelo menos 8 caracteres, misturando letras e números.";
  if (/rate limit|too many/i.test(msg)) return "Limite de envio de e-mails do Supabase atingido. Use o link de redefinição copiado ou a senha provisória.";
  if (/redirect/i.test(msg)) return "O endereço do painel não está liberado no Supabase (Authentication → URL Configuration).";
  return msg;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resposta({ erro: "Método não permitido." }, 405);

  try {
    // 1. Quem está chamando?
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return resposta({ erro: "Sessão ausente. Entre novamente." }, 401);
    const { data: quem, error: erroQuem } = await admin.auth.getUser(token);
    if (erroQuem || !quem || !quem.user) return resposta({ erro: "Sessão expirada. Entre novamente." }, 401);

    const { data: eu } = await admin.from("usuarios").select("*").eq("auth_user_id", quem.user.id).maybeSingle();
    if (!eu || eu.ativo !== true || eu.perfil !== "administrador") {
      return resposta({ erro: "Apenas administradores ativos podem gerenciar acessos." }, 403);
    }

    const corpo = await req.json().catch(() => ({}));
    const acao = String(corpo.acao || "");
    const ctx = { por: eu.id, acao, alvo: corpo.id || corpo.email || null };

    // 2. O que fazer
    switch (acao) {
      case "listar": {
        const { data: linhas, error } = await admin.from("usuarios").select("*").order("nome");
        if (error) throw error;
        const contas = await todasAsContas();
        const porId = new Map(contas.map((c) => [c.id, c]));
        const porEmail = new Map(contas.map((c) => [(c.email || "").toLowerCase(), c]));
        const agora = Date.now();
        const lista = (linhas || []).map((l: any) => {
          const c = (l.auth_user_id && porId.get(l.auth_user_id)) || porEmail.get(String(l.email || "").toLowerCase());
          return {
            id: l.id, nome: l.nome, email: l.email, perfil: l.perfil, ativo: l.ativo,
            conta: c ? {
              criadaEm: c.created_at,
              ultimoAcesso: c.last_sign_in_at || null,
              emailConfirmado: !!c.email_confirmed_at,
              banida: !!(c.banned_until && new Date(c.banned_until).getTime() > agora),
              trocarSenha: !!(c.user_metadata && c.user_metadata.trocar_senha),
            } : null,
          };
        });
        return resposta({ lista, eu: eu.id });
      }

      case "criar": {
        const nome = String(corpo.nome || "").trim();
        const email = String(corpo.email || "").trim().toLowerCase();
        const perfil = ["administrador", "gestor", "operacional"].includes(corpo.perfil) ? corpo.perfil : "operacional";
        if (!nome) throw new ErroDeNegocio("Informe o nome.");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroDeNegocio("Informe um e-mail válido.");
        if (corpo.senha) validarSenha(corpo.senha);

        const { data: jaExiste } = await admin.from("usuarios").select("id").ilike("email", email).maybeSingle();
        if (jaExiste) throw new ErroDeNegocio("Já existe um cadastro com este e-mail.");

        const base = slug(nome);
        let id = base;
        for (let n = 2; n < 50; n++) {
          const { data: ocupado } = await admin.from("usuarios").select("id").eq("id", id).maybeSingle();
          if (!ocupado) break;
          id = `${base}-${n}`;
        }
        const { error: erroIns } = await admin.from("usuarios").insert({ id, nome, email, perfil, ativo: true });
        if (erroIns) throw erroIns;

        if (corpo.senha) {
          const { error: erroConta } = await admin.auth.admin.createUser({
            email, password: corpo.senha, email_confirm: true, user_metadata: { trocar_senha: true },
          });
          if (erroConta) {
            await admin.from("usuarios").delete().eq("id", id); // desfaz o cadastro
            throw erroConta;
          }
        }
        await registrar("acesso: criar", { ...ctx, alvo: id, comSenha: !!corpo.senha });
        return resposta({ ok: true, id });
      }

      case "senha_provisoria": {
        validarSenha(corpo.senha);
        const linha = await cadastro(corpo.id);
        const conta = await contaDoCadastro(linha);
        if (conta) {
          const { error } = await admin.auth.admin.updateUserById(conta.id, {
            password: corpo.senha,
            email_confirm: true,
            user_metadata: { ...(conta.user_metadata || {}), trocar_senha: true },
          });
          if (error) throw error;
        } else {
          if (!linha.ativo) throw new ErroDeNegocio("Desbloqueie o cadastro antes de criar a conta de login.");
          const { error } = await admin.auth.admin.createUser({
            email: linha.email, password: corpo.senha, email_confirm: true, user_metadata: { trocar_senha: true },
          });
          if (error) throw error;
        }
        await registrar("acesso: senha provisória", ctx);
        return resposta({ ok: true });
      }

      case "link_redefinicao": {
        const linha = await cadastro(corpo.id);
        const conta = await contaDoCadastro(linha);
        if (!conta) throw new ErroDeNegocio("Esta pessoa ainda não tem conta de login. Use \"Senha provisória\" para criar.");
        const { data, error } = await admin.auth.admin.generateLink({
          type: "recovery", email: linha.email,
          options: { redirectTo: validarRedirect(corpo.redirectTo) },
        });
        if (error) throw error;
        await registrar("acesso: link de redefinição gerado", ctx);
        return resposta({ ok: true, link: data.properties.action_link });
      }

      case "enviar_email_redefinicao": {
        const linha = await cadastro(corpo.id);
        const publico = createClient(URL_SB, chavePublica(), { auth: { persistSession: false } });
        const { error } = await publico.auth.resetPasswordForEmail(linha.email, {
          redirectTo: validarRedirect(corpo.redirectTo),
        });
        if (error) throw error;
        await registrar("acesso: e-mail de redefinição enviado", ctx);
        return resposta({ ok: true });
      }

      case "bloquear":
      case "desbloquear": {
        const bloquear = acao === "bloquear";
        if (bloquear && corpo.id === eu.id) throw new ErroDeNegocio("Você não pode bloquear o seu próprio acesso.");
        const linha = await cadastro(corpo.id);
        const { error } = await admin.from("usuarios").update({ ativo: !bloquear }).eq("id", linha.id);
        if (error) throw error;
        const conta = await contaDoCadastro(linha);
        if (conta) {
          const { error: erroBan } = await admin.auth.admin.updateUserById(conta.id, {
            ban_duration: bloquear ? "876000h" : "none",
          });
          if (erroBan) {
            await admin.from("usuarios").update({ ativo: linha.ativo }).eq("id", linha.id); // desfaz
            throw erroBan;
          }
        }
        await registrar(bloquear ? "acesso: bloquear" : "acesso: desbloquear", ctx);
        return resposta({ ok: true });
      }

      case "excluir": {
        if (corpo.id === eu.id) throw new ErroDeNegocio("Você não pode excluir o seu próprio acesso.");
        const linha = await cadastro(corpo.id);
        const conta = await contaDoCadastro(linha);
        // Primeiro o cadastro: o gatilho do banco impede apagar o último administrador.
        const { error } = await admin.from("usuarios").delete().eq("id", linha.id);
        if (error) throw error;
        if (conta) {
          const { error: erroDel } = await admin.auth.admin.deleteUser(conta.id);
          if (erroDel) throw erroDel;
        }
        await registrar("acesso: excluir", { ...ctx, nome: linha.nome, email: linha.email });
        return resposta({ ok: true });
      }

      default:
        return resposta({ erro: `Ação desconhecida: ${acao}` }, 400);
    }
  } catch (e) {
    const msg = (e && (e as Error).message) || String(e);
    const status = e instanceof ErroDeNegocio ? 400 : 500;
    console.error("gerenciar-acessos:", msg);
    return resposta({ erro: traduzir(msg) }, status);
  }
});
