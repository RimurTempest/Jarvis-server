# Homologação isolada da Fase 14

Esta pasta contém uma cópia isolada do armazenamento e dos testes da Fase 14. Não está conectada ao servidor implantado e não deve substituir os arquivos do Codespace ou as alterações posteriores.

O commit `20a0a8ab8626c6e04f94d8ebabf7a5c7620a689e` passou em 57 asserções usando PostgreSQL 16 temporário no GitHub Actions, incluindo concorrência na reserva, vencimento, revogação administrativa no armazenamento e corrida entre revogar e concluir. A revogação limpa a reserva e bloqueia o relatório quando vence a disputa.

As 87 verificações da Fase 14 também passaram localmente no Node 24 depois de selecionar explicitamente o formato TAP no harness incluído aqui. A suíte completa continua no ZIP da Fase 14; esta pasta contém somente o armazenamento, o teste SQL e o harness alterado.

Ainda faltam conciliar com a worktree original e a revisão implantada, expor e autenticar a operação de revogação, renovar reservas independentemente, cancelar processos/contêineres em execução, impedir commit após revogação, isolamento real de execução, orçamento agregado, IA real, integração Android e testes no telefone. Não usar testes SQL como prova de aprendizado ou autoatualização.
