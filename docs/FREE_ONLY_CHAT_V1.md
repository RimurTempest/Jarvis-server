# JARVIS — conversa com IA pelos provedores existentes, custo zero controlado

## Objetivo
O aplicativo 2.7.6 conversa por texto com o servidor sem habilitar ferramentas,
pesquisa, memória persistente, automações, autoaperfeiçoamento ou ações Android.

O servidor **já aceita até 10 provedores OpenAI-compatíveis** configurados
pelas variáveis `JARVIS_PROVIDER_1_NAME`, `JARVIS_PROVIDER_1_MODEL`,
`JARVIS_PROVIDER_1_API_KEY`, `JARVIS_PROVIDER_1_BASE_URL`, até o slot 10.
O provedor Groq também pode existir por `GROQ_API_KEY`.
O código de chat seguro reutiliza exclusivamente os **clientes já registrados**.
Não requer nova API key nem novo cartão.

Provedores reconhecidos nesta fase, quando o endpoint HTTPS corresponder:
HuggingFace, NVIDIA, ZAI/Z.ai, OpenRouter, Cloudflare, Groq e Gemini.
Nem todo endpoint nem todo modelo desses provedores é necessariamente gratuito.

## Política obrigatória (desligado por padrão)

Para liberar o chat, o responsável precisa confirmar no painel de **cada
provedor e cada modelo** que a conta não cobrará nada, nem excedentes, e
que está dentro de cota gratuita. O servidor NÃO consegue validar sozinho
o estado de faturamento dessas contas.

Três variáveis não secretas de controle:
- `JARVIS_FREE_CHAT_ENABLED=true` — habilitação explícita;
- `JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN=true` — declaração explícita do
  proprietário de que as contas/modelos autorizados estão em plano
  gratuito, sem cobrança;
- `JARVIS_FREE_CHAT_APPROVED_MODELS_JSON` — JSON exato dos pares
  **nome e identificador do modelo já configurados**, por exemplo
  `[{"provider":"Groq","model":"openai/gpt-oss-20b"}]` **somente se**
  esse par tiver sido conferido no console da conta.

Não use nomes aproximados nem um modelo fictício. O JSON poderá conter
outros pares já configurados (`HuggingFace`, `NVIDIA`, `ZAI`,
`OpenRouter`, `Cloudflare`, `Gemini`), mas cada modelo deve ser
confirmado individualmente e ser idêntico a `JARVIS_PROVIDER_N_MODEL`.
No OpenRouter, só são aceitos nomes de modelos terminados em `:free`.
O código também restringe cada nome ao domínio oficial do provedor:
uma rota que aponte para `api.openai.com` não pode passar como Groq
ou outro serviço. Uma entrada inválida desabilita a lista inteira.

Nenhuma chave deverá ser copiada para chat, commit, screenshot ou logs.
**Não habilite as três variáveis antes das verificações de cobrança.**
Não presuma que créditos promocionais equivalem a cobrança permanentemente
desativada.

## APIs

- `GET /api/chat/safe/status`: autenticado por token revogável de aparelho
  pareado. Retorna `enabled`, `freeOnly`, `providerCount`, nomes e
  modelos aprovados, teto diário e restrições de execução; **não chama IA**.
- `POST /api/chat/safe`: aparelho pareado, mensagem de até 700 caracteres,
  reservando **um dos 8 pedidos/dia** por aparelho em PostgreSQL antes de
  qualquer chamada externa. Seleciona um único par previamente aprovado
  conforme o contador do dia, em rotação determinística; **não tenta
  alternativas** se esse provedor falhar.
- Teto de 384 tokens de conclusão por solicitação. Se o provedor falhar,
  não haverá fallback para modelos gratuitos nem pagos naquela chamada.
- Dados da mensagem/resposta não são gravados neste endpoint; a cota diária
  exige guardar identificador do aparelho, data e contagem. A infraestrutura
  de pareamento pode atualizar metadados de uso.

A rota padrão `/api/chat` continua separada e não é usada na prévia,
porque ela inclui memória, tarefas e fluxos de autoaperfeiçoamento.

## Segurança de deploy

É seguro publicar o código com as variáveis ausentes ou `false`: sem
aprovação exata, todas as chamadas respondem com chat indisponível e
**nenhum provedor é chamado**. Sem chave de assinatura Android no servidor.
Executar `npm test` e validações do GitHub antes de mesclar.

Limites de uso reduzem o consumo, mas **não asseguram custo zero sozinhos**.
O custo zero depende também de contas sem faturamento habilitado. Havendo
dúvida, manter `JARVIS_FREE_CHAT_ENABLED=false` até revisar a conta.
