# JARVIS — conversa IA gratuita, isolada e controlada (fase 2)

## Objetivo
Adicionar **conversação somente por texto** no aplicativo 2.7.6 sem habilitar
o chat completo, ferramentas, pesquisa, habilidades remotas, automação,
memória persistente, autoaperfeiçoamento ou qualquer provedor pago.

## Endpoints
- `GET /api/chat/safe/status`: somente para dispositivo pareado e ativo.
  Retorna se o modo está habilitado, modelo fixo, limite e restrições.
- `POST /api/chat/safe`: somente para dispositivo pareado. Recebe
  `{"message":"olá"}` (até 700 caracteres), nunca áudio nem localização.
  Retorna até 3.000 caracteres da resposta e a cota diária restante.
- Credencial de pareamento Android validada e revogável no PostgreSQL.
  Um token de administração **não** substitui o pareamento.
- Requisição de IA limitada a **um único** modelo
  `openai/gpt-oss-20b` no GroqCloud. Sem fallback para outros provedores.
- Sem histórico ou memória nesta rota. Somente contagem por aparelho/dia
  em uma tabela PostgreSQL própria, necessária ao controle de cota.

## Política de custo (fail closed)
A rota fica DESATIVADA até todas as três condições:
1. `GROQ_API_KEY` configurado no ambiente protegido do Render;
2. `JARVIS_FREE_CHAT_CONFIRMED_FREE_PLAN=true` somente após o
   proprietário verificar pessoalmente, no console Groq, que está no plano
   **Free**, sem faturamento ativo, cartão ou upgrade;
3. `JARVIS_FREE_CHAT_ENABLED=true`.

NUNCA enviar a chave por GitHub, ChatGPT, logs ou arquivos.
**O servidor não consegue auditar o estado real de cobrança do provedor.**
Essas variáveis são uma declaração operacional, não comprovação técnica.
Se o plano passar a ser pago, desabilitar imediatamente o modo e remover
a variável da primeira condição ou alterar ENABLED para false.

O servidor reserva no PostgreSQL uma cota máxima de **8 pedidos/dia por
aparelho**, antes de cada consulta ao Groq. Falhas também consomem cota
para impedir loops. Uma resposta tem teto de 384 tokens de conclusão.
Se houver erro ou limite no provedor, falha sem tentar provedor alternativo.
Esses limites reduzem uso, mas **não são garantia monetária por si sós**:
é indispensável manter o provedor no plano gratuito sem faturamento.

## Segurança e limitações
- Sem tool calls, busca web, execução de ação Android, fila, auto-merge ou OTA.
- Não reaproveita a rota antiga `/api/chat`, que possui fluxos de aprendizado.
- Não persiste texto das perguntas ou respostas; autenticação do dispositivo
  atualiza sua data de acesso conforme a infraestrutura existente.
- O serviço de reconhecimento de voz do Android é independente e pode
  enviar áudio ao fornecedor do reconhecedor, conforme sistema e configuração.
- A prévia Android requer pareamento explícito; cada pacote de testes é uma
  instalação independente. Ações Android e OTA permanecem bloqueadas.
- Testar localmente: `npm test`; rodar CI e revisão antes de mesclar.

## Importante
Publicar esta rota **desligada** em produção é seguro por padrão.
Não preencher/ativar as variáveis sem verificar o estado de cobrança da
conta no console do provedor. Nenhum custo ou chamada de IA é efetuado
pelo deploy, pelo status ou pelos testes.
