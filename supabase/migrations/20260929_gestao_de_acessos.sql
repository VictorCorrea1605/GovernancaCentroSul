-- JÁ APLICADO no projeto Supabase da Centro Sul (29/09/2026). Guardado aqui só como registro.
-- Bloquear = usuarios.ativo false => perde acesso a todos os dados na hora (RLS).
create or replace function public.eh_usuario_ativo()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from usuarios where auth_user_id = auth.uid() and ativo = true);
$$;
create or replace function public.eh_admin()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from usuarios where auth_user_id = auth.uid() and ativo = true and perfil = 'administrador');
$$;
revoke execute on function public.eh_usuario_ativo() from public, anon;
revoke execute on function public.eh_admin() from public, anon;
grant execute on function public.eh_usuario_ativo() to authenticated;
grant execute on function public.eh_admin() to authenticated;

create or replace function public.proteger_ultimo_admin()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if old.perfil = 'administrador' and old.ativo = true
     and (tg_op = 'DELETE' or new.perfil <> 'administrador' or new.ativo = false) then
    if not exists (select 1 from usuarios where perfil = 'administrador' and ativo = true and id <> old.id) then
      raise exception 'Não é possível excluir, bloquear ou rebaixar o último administrador ativo.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;
create trigger trg_proteger_ultimo_admin before update or delete on public.usuarios
  for each row execute function public.proteger_ultimo_admin();

-- Políticas anteriores ("qualquer autenticado") trocadas por "autenticado E ativo";
-- cadastro de usuários só por administrador. Ver pg_policies para o estado atual.
-- (texto completo das políticas: ver histórico de migrações no painel do Supabase)

-- Também aplicado antes (endurecimento): RLS em logs_sistema e
-- revoke execute de vincular_auth_user_a_usuarios para anon/authenticated.
