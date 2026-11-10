# JARVIS — resposta falada progressivamente, como a versão 2.6

A rota `POST /api/chat/safe/stream` restaura o fluxo de frases da
JARVIS Android 2.6, mas **não usa** o canal de ações `/api/chat`.

## Contrato
- Token revogável de aparelho previamente pareado.
- Requisição JSON: `message` (até 700 caracteres) e
  `history` opcional (no máximo seis turnos user/assistant,
  até 1600 caracteres somados). Histórico recebido é descartado,
  não persistido.
- Resposta `application/x-ndjson`:
  - `start`: `schemaVersion=1`, nome/modelo do provedor,
    `freeOnly=true`, `executedActions=false`, `persisted=false`;
  - `delta`: pedaço de texto, renderizado e falado em frases pelo Android;
  - `done`: confirmação final de segurança e saldo de consultas;
  - `error`: comunicação interrompida, sem fallback pago.
- Nenhuma ferramenta, busca, memória, execução, evolução, instalação
  ou fila é acessível pelo endpoint.
- O provedor é escolhido automaticamente, em rodízio, por
  `chooseFreeChatProvider`, entre os modelos exatos aprovados e
  verificados como gratuitos.
- A cota PostgreSQL de pedidos gratuitos continua sendo reservada
  antes da chamada ao provedor. Sem aprovação/cota, 503/429
  **antes** de qualquer chamada de IA.

## Condições de ativação
O endpoint existe no código, mas permanece **desligado** até que o
proprietário verifique nos painéis de seus provedores as condições
de cobrança e configure a lista de modelos permitidos junto às flags
`JARVIS_FREE_CHAT_ENABLED` e
`JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN`.
Não adicionar cartão nem retirar proteções de faturamento.
Ter `JARVIS_PROVIDER_N_API_KEY` configurado não comprova que o
modelo `JARVIS_PROVIDER_N_MODEL` é gratuito.

## Testes
Teste de validação de histórico, limite de saída, somente deltas
de texto, protocolo seguro e fluxo inexistente. Revisão Android de
estado do botão, TTS progressivo e integração física no POCO.
