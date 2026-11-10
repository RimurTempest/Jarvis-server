# JARVIS — Habilidades v1 (somente leitura)

Esta branch inicia as habilidades do JARVIS sem abrir acesso ao telefone,
executar comandos do sistema, comprar produtos, alterar arquivos ou iniciar
serviços remunerados.

## Rotas

- `GET /api/skills`: catálogo com campos `schemaVersion=1`,
  `mode=catalog-only`, `autoExecution=false`, `capabilities[]`.
- `POST /api/skills/resolve`: recebe JSON com
  `{"utterance":"nível da bateria"}` e retorna apenas uma sugestão
  `decision=suggest|unavailable|catalog|none`, `skillId`,
  `executed=false` e `requiresOwnerConfirmation`.
  A resposta **não executa** a sugestão.

Ambas exigem cabeçalho HTTP
`Authorization: Bearer <JARVIS_SKILLS_READ_TOKEN>`.
Uma credencial `JARVIS_API_TOKEN` válida para chat **não serve**
para essas rotas; são escopos distintos.

## Configuração no Render

1. Gerar localmente um token aleatório com **pelo menos 32 caracteres**;
   não reutilizar `JARVIS_API_TOKEN`, chaves de IA ou tokens de API.
2. Na configuração segura do serviço, adicionar
   `JARVIS_SKILLS_READ_TOKEN` com esse valor.
3. Fazer revisão, merge e deploy da branch do servidor antes de usar
   `COMANDOS > CATÁLOGO ONLINE` no JARVIS Android 2.7.5.
4. Digitar o token **no telefone**, não em chats, commit, screenshot ou log.
   A aplicação guarda a credencial cifrada usando Android Keystore,
   separadamente do pareamento do dispositivo.
5. Para revogar, substituir ou apagar o token no Render e limpar a
   credencial do app.

Sem a variável configurada, as rotas respondem HTTP 401. Não há
acesso anônimo nem chave padrão.

## Habilidades declaradas

- `server.health`: diagnóstico informativo.
- `assistant.chat`: disponibilidade baseada em configuração de banco/IA,
  sem efetuar chat pelo endpoint de catálogo.
- `research.web`: disponibilidade informativa de pesquisa já configurada;
  não pesquisa automaticamente.
- `memory.persistent`: memória somente se o serviço estiver pronto.
- `phone.battery`, `phone.network` e `phone.android`: funções locais do
  APK Android 2.7.5, sem comando remoto.

O catálogo diferencia **implementado** e **disponível**. A disponibilidade
informada é baseada na configuração do servidor, não é garantia de uma
requisição de IA bem-sucedida.

## Segurança

- Nenhum método de execução arbitrária.
- Nenhuma função `child_process`, shell, Android action bridge ou plugin externo.
- Sem aceitar comandos de aquisição, pagamento, exclusão ou alteração
  por texto; consultas são declarativas e de leitura.
- Strings desconhecidas retornam `none`.
- Rotas de chat e de memória existentes não mudam.
- O usuário pode desligar o microfone do app independentemente do servidor.
- Não enviar áudio, geolocalização ou mensagens com `GET /api/skills`.
- Nenhum custo de IA associado às duas rotas novas.

## Testes

`npm test` executa testes com o `node:test` embutido, sem chaves de IA,
sem conexão com Render e sem banco de dados.

**Importante:** este documento descreve o código da branch. A rota só
estará disponível no servidor público depois de revisão, merge,
configuração da variável de ambiente e deploy real.
