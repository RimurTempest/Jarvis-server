Prototipo isolado: heartbeat e cancelamento de subprocessos

Contem dispatcher adaptado para sinalizar perda de reserva, processo local cancelavel e testes com subprocessos inofensivos. O worker real e Git sao STUBS deliberadamente bloqueados aqui; este pacote nao e um executor funcional. Ele nao mata nem verifica containers Docker por si so. O supervisor F13 continua bloqueado, sem uso de IA real.

Os testes verificam apenas o processo simulado e nao provam ausencia de commit em uma corrida distribuida com revogacao. Antes de integracao: reconciliar com a worktree F13 real, eliminar bloqueios sincronos, comprovar abort/limpeza de container rootless, sincronizar a revogacao e a barreira do commit, validar timeout, PostgreSQL e CI real. Nada aqui e publicado, instalado ou aprendido.
