const GREEN_STATES = new Set(["draft_pr_created", "runtime_verified"]);
const RED_STATES = new Set(["failed", "rolled_back", "merge_unverified"]);

const MESSAGES = Object.freeze({
  queued: "Pedido recebido; a autoatualização ainda não foi enviada.",
  researching: "Pesquisando como implementar a capacidade solicitada.",
  collecting_context: "Analisando o código atual antes de preparar a atualização.",
  generating: "Preparando a proposta de autoatualização.",
  publishing: "Enviando a proposta e verificando os testes.",
  draft_pr_created: "Autoatualização enviada para revisão. A proposta está disponível no GitHub.",
  merged: "Atualização integrada; aguardando confirmação de que a versão está saudável.",
  runtime_verified: "Autoatualização aplicada e confirmada em execução.",
  failed: "A autoatualização falhou; nenhuma conclusão de sucesso foi registrada.",
  rolled_back: "A atualização apresentou problema e foi revertida com confirmação.",
  merge_unverified: "Não foi possível confirmar a atualização ou a recuperação; é necessária uma verificação.",
});

export function getSelfImprovementVisualState(state) {
  if (typeof state !== "string" || !MESSAGES[state]) {
    return {
      visualState: "red",
      label: "Estado desconhecido",
      shouldNotifyUser: true,
      message: "O JARVIS não reconhece o estado desta autoatualização; verifique o registro da execução.",
    };
  }

  const visualState = GREEN_STATES.has(state) ? "green" : RED_STATES.has(state) ? "red" : "white";
  return {
    visualState,
    label: visualState === "green" ? "Autoatualização enviada" : visualState === "red" ? "Autoatualização bloqueada" : "Processando autoatualização",
    shouldNotifyUser: visualState !== "white",
    message: MESSAGES[state],
  };
}
