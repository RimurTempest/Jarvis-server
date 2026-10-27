Prototipo isolado de heartbeat e cancelamento, nao implantado.

O dispatcher propaga cancelamento ao perder reserva, limita o tempo de renovacao e volta a verificar antes do commit. O adaptador F13 possui caminho Docker assincrono que preserva o perfil rootless, staging isolado e limpeza verificada. O executor legado fica bloqueado e o supervisor real permanece desativado. O caminho F14 para F13 nos testes e injetado localmente e ainda nao foi aplicado na worktree original.

No ambiente local: 87 testes da F14, 48 de seguranca F13, 11 do subprocesso e dispatcher e 2 com Git local passaram. Os testes Docker usam simulacoes; NAO foi executado Docker rootless real. O banco PostgreSQL foi testado separadamente em CI na branch work/fase14-postgres-isolado.

Limites: outros comandos Git e verificacoes de sintaxe permanecem sincronos; uma renovacao antes do commit ainda nao resolve atomicamente a corrida distribuida entre revogacao e commit. Timeout de criacao Docker pode deixar resultado ambiguo; exige reconciliacao. Falta integrar e comprovar controle de processo/conteiner real, fencing atomico do commit, orcamento agregado, reconciliacao com worktree original, IA real, integracao com Android e teste no celular. Nao declarar aprendizado, publicacao ou instalacao.
