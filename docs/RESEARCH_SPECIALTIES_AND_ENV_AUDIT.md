# J.A.R.V.I.S. — Pesquisadores por especialidade e auditoria do Environment

## Objetivo
Evitar que uma única busca EXA responda a todas as pesquisas. A seleção
é determinística e proporcional à pergunta, com várias fontes que se
complementam, sem supor que os resultados são verdadeiros por si sós.

| Pesquisador | Responsabilidade | Necessita chave | Política inicial |
|---|---|---|---|
| Agência Brasil / EBC | Notícias oficiais nacionais | Não | Permitido, consulta apenas feed RSS |
| GDELT | Cobertura jornalística internacional | Não | Permitido, busca limitada aos últimos 3 dias |
| Tavily | Busca web geral e apoio a pesquisa | Sim, `TAVILY_API_KEY` | Desligado até atestado gratuito |
| EXA | Documentação especializada, estudos, manuais | Sim, `EXA_API_KEY` | Desligado até atestado gratuito |

Duas fontes podem atuar sobre a mesma consulta nacional e internacional.
Não haverá fallback automático de Tavily/EXA para provedores pagos.
A ausência ou indisponibilidade de fontes deve ser informada, não
substituída por afirmações inventadas.

## Configuração não secreta

- `JARVIS_SEARCH_TAVILY_ENABLED=true` **e**
  `JARVIS_SEARCH_TAVILY_FREE_ATTESTED=true` autorizam Tavily somente
  quando `TAVILY_API_KEY` já estiver configurada.
- `JARVIS_SEARCH_EXA_ENABLED=true` **e**
  `JARVIS_SEARCH_EXA_FREE_ATTESTED=true` autorizam EXA somente quando
  `EXA_API_KEY` já estiver configurada.
- Não criar nem substituir API keys de provedores existentes.
- Não adicionar cartão ou desabilitar proteção de faturamento.
- Uma chave presente **não comprova** gratuidade: conferir modelo,
  provedor, plano, excedentes e período de cortesia antes de habilitar.
- GDELT e Agência Brasil não precisam de credenciais individuais; limites
  de uso e bloqueios temporários podem existir mesmo em feeds gratuitos.

## Rotas por aparelho pareado

### `GET /api/research/status`
Autenticação: token de pareamento Android revogável, em
`Authorization: Bearer <token>` e `X-Jarvis-Device-Id`.
Retorna apenas dados de configuração para o proprietário pareado:

- Pesquisadores, funções e se estão autorizados;
- Provedores de IA **realmente registrados pelo processo** e nomes
  dos modelos, sem os tokens;
- Inventário de nomes de variáveis relevantes ao JARVIS, cada um com
  `configured: true/false`, sem quaisquer valores.

Essa resposta **não é uma cópia integral do Environment do Render**.
Não mostra outras variáveis privadas do sistema, não comprova cobrança,
nem valida automaticamente acesso real às APIs. É uma auditoria
restringida ao processo em execução, depois de publicada a branch.

### `POST /api/research/query`
Recebe `{"query":"pesquise notícias do Brasil sobre energia"}`,
até 180 caracteres; até **6 solicitações diárias por aparelho**,
registradas atomicamente no PostgreSQL. Retorna fontes, URL, data e
qual pesquisador encontrou cada resultado. Não executa ações do Android
e não solicita IA nem memória persistente. Tem política de tempo e
tamanho da resposta, bloqueia redirects e deduplica URLs.

## Integração Android

`COMANDOS > PESQUISADORES E ENVIRONMENT` lê o diagnóstico
mediante vínculo prévio, sem chaves expostas. Ativação de pesquisa é
opcional e separada da conversa com IA e do microfone.
Uma pesquisa explícita («pesquise notícias do Brasil») chama a API,
mas o app apenas apresenta as fontes e não inventa síntese por LLM.

O núcleo holográfico e o mini-globo da versão 2.7.4 não são modificados.

## Dependências e status de segurança

- Os provedores de IA HuggingFace, NVIDIA, ZAI, OpenRouter, Cloudflare,
  Groq e Gemini continuam definidos em `JARVIS_PROVIDER_N_*` ou
  integrações legadas, conforme o Environment real do Render;
  esta PR não modifica as credenciais.
- Não altera a condição de ativação do autoaperfeiçoamento.
- Nunca transmitir os valores de `GROQ_API_KEY`, `DATABASE_URL`,
  `JARVIS_API_TOKEN`, `JARVIS_GITHUB_TOKEN` ou outros segredos
  pela resposta da API.
- Verificar testes do GitHub e a versão publicada no Render antes de
  aceitar o diagnóstico como disponível.
