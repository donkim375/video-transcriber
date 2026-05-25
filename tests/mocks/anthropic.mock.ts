export type FakeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export type FakeResponse = {
  stop_reason: 'end_turn' | 'tool_use'
  content: FakeContentBlock[]
}

export class FakeAnthropic {
  public calls: Array<{ system: unknown; messages: unknown[]; tool_choice?: unknown }> = []
  private queue: FakeResponse[]

  constructor(responses: FakeResponse[]) {
    this.queue = [...responses]
  }

  messages = {
    create: async (params: any): Promise<FakeResponse> => {
      this.calls.push({ system: params.system, messages: params.messages, tool_choice: params.tool_choice })
      const next = this.queue.shift()
      if (!next) throw new Error('FakeAnthropic: ran out of scripted responses')
      return next
    },
  }
}
