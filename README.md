# One Page Executivo — Gestão Administrativa

Sistema de acompanhamento dos indicadores administrativos da Âmbar Energia
(ADM-001 a ADM-026).

Esta é a versão publicável do protótipo aprovado: **as telas são o mesmo
código já validado**, sem reescrita. O que mudou é onde os dados moram —
antes num banco interno da plataforma onde o protótipo rodava, agora num
banco PostgreSQL de verdade (Supabase), com login por pessoa e histórico
compartilhado por toda a equipe.

## Como publicar

É um site estático: não tem build, não tem dependência para instalar.

1. No repositório do GitHub, **apague tudo o que está lá** e suba todos os
   arquivos desta pasta na raiz (não dentro de uma subpasta).
2. Na Vercel, importe o repositório e publique.
3. Pronto. A URL do projeto já abre o sistema.

O arquivo `vercel.json` incluído aqui já diz à Vercel que não existe nada
para compilar, e essa instrução tem prioridade sobre o que estiver
configurado no painel. Ou seja: mesmo reaproveitando o projeto que rodava a
versão anterior em Next.js, não é preciso mexer nas configurações de build.

A única exceção é o campo **Root Directory** (em *Settings → General*), que
não pode ser definido por arquivo. Se ele estiver apontando para alguma
subpasta — `onepage-app`, por exemplo — precisa ser esvaziado, porque agora
os arquivos ficam na raiz do repositório. Se estiver vazio, não há nada a
fazer.

## Como cada pessoa entra

Quem já está cadastrado em **Responsáveis** cria a própria senha na aba
"Primeiro acesso" da tela de login, usando o e-mail que está no cadastro.
Quem não está cadastrado não consegue criar acesso — é assim de propósito.

Para incluir alguém novo: entre no sistema, vá em **Responsáveis → + Novo
responsável**, cadastre nome e e-mail, e peça para a pessoa fazer o primeiro
acesso.

O login por e-mail e senha é provisório e foi montado para ser trocado pelo
login corporativo da Microsoft (Entra ID) **sem recadastro**: a identidade de
cada pessoa é a linha dela na tabela de usuários, que não muda. Quando o TI
liberar as credenciais, só a tela de login e o arquivo `auth.js` mudam.

## Os arquivos

Vindos do protótipo, sem alteração de estrutura, cores ou textos:

| Arquivo | O que é |
| --- | --- |
| `app.css` | Toda a aparência do sistema. Idêntico ao protótipo, byte a byte. |
| `engines.js` | Os motores de cálculo dos indicadores. O do protótipo, com um motor novo acrescentado ao final da lista (o de conformidade por status, usado pelo ADM-005) — nenhum motor existente foi alterado. |
| `app.js` | Todas as telas. Idêntico ao protótipo, com duas exceções descritas abaixo. |
| `logo.png` | Marca Âmbar Energia. |

Criados para esta versão:

| Arquivo | O que é |
| --- | --- |
| `db.js` | Conversa com o banco PostgreSQL. Tem exatamente as mesmas funções que a versão antiga — é o que permite o `app.js` continuar intacto. |
| `auth.js` | Tela de login, sessão e avisos de erro. |
| `auth.css` | Estilo só da tela de login (o `app.css` não foi tocado). |
| `config.js` | Endereço e chave pública do banco. |
| `index.html` | Página que junta tudo. |
| `supabase.js` | Biblioteca do Supabase, guardada aqui no repositório em vez de vir de um CDN — assim o sistema abre mesmo em rede corporativa restrita. |

### O que mudou no `app.js`

Duas coisas, ambas por causa do login de verdade:

1. Quem está logado passa a vir da sessão autenticada, em vez do seletor
   "Você é [nome]" que existia para simular usuários na validação.
2. Esse seletor deu lugar ao nome da pessoa logada e ao botão **Sair**.

E uma correção de bug que valia para os dois mundos: os campos numéricos
aceitavam a vírgula do teclado brasileiro só na aparência — quem digitava
`86,5` gravava **865**, sem aviso nenhum. Agora a vírgula é aceita e
convertida corretamente, tanto na digitação quanto na importação em lote.

## Onde os dados ficam

No Supabase (projeto `onepage-executivo-ambar`), nas tabelas `areas`,
`categorias`, `usuarios`, `indicadores`, `registros_indicador` e
`historico_alteracoes`.

Duas regras do protótipo continuam valendo, agora garantidas pelo próprio
banco:

- **Resultado e status nunca são armazenados.** São sempre recalculados a
  partir dos dados de entrada na hora da leitura. É isso que faz uma
  correção de mês passado reprocessar tudo automaticamente.
- **O catálogo de indicadores é fechado** em ADM-001..ADM-026. O banco
  recusa qualquer indicador fora dessa faixa e qualquer tentativa de passar
  de 26. Incluir um novo indicador é um ato deliberado, feito no banco.

A chave que está no `config.js` é a chave **pública** do projeto — ela é
feita para ficar visível no navegador e sozinha não dá acesso a nada: quem
protege os dados são as regras de acesso do banco, que só respondem para
quem está autenticado. Pode ficar no GitHub. A chave secreta do projeto
nunca deve ser colocada aqui.
