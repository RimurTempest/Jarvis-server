Prototipo isolado de heartbeat e cancelamento, nao implantado.

O dispatcher sinaliza perda de reserva, limita o prazo de renovacao e volta a verificar antes do commit. O caminho experimental usa Git e verificacoes de sintaxe assincronos; o sandbox F13 experimental usa Docker assincrono, preserva perfil rootless, staging isolado e limpeza verificada. O executor legado fica bloqueado e o supervisor real permanece desativado. A ponte F14→F13 e injetada apenas nos testes; nao foi aplicada na worktree original.

Verificacoes locais incluem testes em Node 24, processos benignos, Git local e Docker simulado. O PostgreSQL foi testado separadamente na branch work/fase14-postgres-isolado. Nenhuma chamada de IA real ou Docker rootless real ocorreu aqui.

Limites: varias operacoes de filesystem continuam sincrons; a renovacao antes do commit nao resolve atomicamente a corrida distribuida entre revogacao e commit local. Timeout na criacao de container pode deixar estado ambiguo e exige reconciliacao. Faltam integracao e teste de isolamento rootless real, barreira atomica ou outra garantia para commit, controle real de orcamento, reconciliacao com a worktree original, IA real e teste Android. Nenhuma habilidade foi publicada, instalada ou aprendida.
