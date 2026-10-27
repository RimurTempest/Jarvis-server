Prototipo de registro de orcamento em PostgreSQL, isolado e nao integrado ao provedor.

A reserva valida lease ativa, registra prazo de 15 minutos, ate quatro chamadas e ate duas correcoes e usa uma politica de cotacao fornecida por codigo confiavel. Uma tentativa sem resultado continua reservando o valor maximo. O teste usa somente precos e consumo simulados. Nao chamar IA real com este prototipo.

Nao ha integracao com o cliente OpenAI, configuracao verificada de precos, limites comprovados de tokens internos da pesquisa, nem reconciliacao automatica de processos interrompidos. Em particular, a cotacao ficticia do teste nao e um teto real de cobranca. Sem limites superiores verificaveis para todo o uso da ferramenta e politica atualizada, chamada com pesquisa deve permanecer bloqueada. O teto real depende desses controles e da cobranca do provedor.
