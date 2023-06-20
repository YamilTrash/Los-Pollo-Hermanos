import { Request } from "express";
import { z } from "zod";
import { isCompletionRequest } from "../common";
import { RequestPreprocessor } from ".";
// import { countTokens } from "../../../tokenization";

// https://console.anthropic.com/docs/api/reference#-v1-complete
const AnthropicV1CompleteSchema = z.object({
  model: z.string().regex(/^claude-/, "Model must start with 'claude-'"),
  prompt: z.string({
    required_error:
      "No prompt found. Are you sending an OpenAI-formatted request to the Claude endpoint?",
  }),
  max_tokens_to_sample: z.coerce.number(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.coerce.number().optional().default(1),
  top_k: z.coerce.number().optional().default(-1),
  top_p: z.coerce.number().optional().default(-1),
  metadata: z.any().optional(),
});

// https://platform.openai.com/docs/api-reference/chat/create
const OpenAIV1ChatCompletionSchema = z.object({
  model: z.string().regex(/^gpt/, "Model must start with 'gpt-'"),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
      name: z.string().optional(),
    }),
    {
      required_error:
        "No prompt found. Are you sending an Anthropic-formatted request to the OpenAI endpoint?",
    }
  ),
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  n: z
    .literal(1, {
      errorMap: () => ({
        message: "You may only request a single completion at a time.",
      }),
    })
    .optional(),
  stream: z.boolean().optional().default(false),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.coerce.number().optional(),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logit_bias: z.any().optional(),
  user: z.string().optional(),
});

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const sameService = req.inboundApi === req.outboundApi;
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable = !isCompletionRequest(req);

  if (alreadyTransformed || notTransformable) {
    return;
  }

  if (sameService) {
    // Just validate, don't transform.
    const validator =
      req.outboundApi === "openai"
        ? OpenAIV1ChatCompletionSchema
        : AnthropicV1CompleteSchema;
    const result = validator.safeParse(req.body);
    if (!result.success) {
      req.log.error(
        { issues: result.error.issues, body: req.body },
        "Request validation failed"
      );
      throw result.error;
    }
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "anthropic") {
    req.body = openaiToAnthropic(req.body, req);
    return;
  }

  if (req.inboundApi === "openai" && req.outboundApi === "shikiho") {
    req.body = openAiToShikiho(req);
    req.log.debug("Transformed OpenAI-to-Shikiho request");
    return;
  }

  throw new Error(
    `'${req.inboundApi}' -> '${req.outboundApi}' request proxying is not supported. Make sure your client is configured to use the correct API.`
  );
};

function openAiToShikiho(req: Request) {
  // Shikiho request format is pretty simple.
  // {"question":"cool","history":[["test"," Hello! How may I assist you?"],["what is your name?"," My name is Claude."]],"newTextInput":""}
  // not sure what `newTextInput` is for, never seen it used.

  const result = OpenAIV1ChatCompletionSchema.safeParse(req.body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Shikiho request"
    );
    throw result.error;
  }

  // // `history` appears to be a list of turns between the user and the assistant.
  // // It doesn't appear to deal with `system` messages at all.
  // // We will just try to force the entire messages array into the first history
  // // turn and then use the last message as the question.

  // const { messages } = result.data;

  // // `question` is anything after the last assistant message.
  // // `history` is everything before that.
  // const lastAssistantMessageIndex = messages
  //   .map((m) => m.role)
  //   .lastIndexOf("assistant");

  // let history;
  // if (lastAssistantMessageIndex === -1) {
  //   history = [];
  // } else {
  //   history = messages
  //     .slice(0, lastAssistantMessageIndex + 1)
  //     .map((m) => {
  //       let role: string = m.role;
  //       if (role === "assistant") {
  //         role = "Assistant";
  //       } else if (role === "system") {
  //         role = "System";
  //       } else if (role === "user") {
  //         role = "Human";
  //       }
  //       return `\n\n${role}: ${m.content}`;
  //     })
  //     .join("");
  // }

  // const question = messages
  //   .slice(lastAssistantMessageIndex + 1)
  //   .map((m) => {
  //     let role: string = m.role;
  //     if (role === "system") role = "System";
  //     if (role === "user") role = "Human";
  //     return `${role}: ${m.content}`;
  //   })
  //   .join("\n\n");

  // req.log.info(
  //   {
  //     history,
  //     question,
  //     lastAssistantMessageIndex,
  //   },
  //   "Transformed OpenAI-to-Shikiho request"
  // );

  // the above doesn't work very well, the assistant gets confused due to the
  // weird formatting imposed by Shikiho. just send a blank history and the
  // entire message array as the question.
  const history = "";
  const question = openaiToAnthropic(req.body, req).prompt;

  return {
    history,
    question,
    newTextInput: "",
  };
}

function openaiToAnthropic(body: any, req: Request) {
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.error(
      { issues: result.error.issues, body: req.body },
      "Invalid OpenAI-to-Anthropic request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;
  const prompt =
    result.data.messages
      .map((m) => {
        let role: string = m.role;
        if (role === "assistant") {
          role = "Assistant";
        } else if (role === "system") {
          role = "System";
        } else if (role === "user") {
          role = "Human";
        }
        // https://console.anthropic.com/docs/prompt-design
        // `name` isn't supported by Anthropic but we can still try to use it.
        return `\n\n${role}: ${m.name?.trim() ? `(as ${m.name}) ` : ""}${
          m.content
        }`;
      })
      .join("") + "\n\nAssistant: ";

  // Claude 1.2 has been selected as the default for smaller prompts because it
  // is said to be less pozzed than the newer 1.3 model. But this is not based
  // on any empirical testing, just speculation based on Anthropic stating that
  // 1.3 is "safer and less susceptible to adversarial attacks" than 1.2.
  // From my own interactions, both are pretty easy to jailbreak so I don't
  // think there's much of a difference, honestly.

  // If you want to override the model selection, you can set the
  // CLAUDE_BIG_MODEL and CLAUDE_SMALL_MODEL environment variables in your
  // .env file.

  // Using "v1" of a model will automatically select the latest version of that
  // model on the Anthropic side.

  const CLAUDE_BIG = process.env.CLAUDE_BIG_MODEL || "claude-v1-100k";
  const CLAUDE_SMALL = process.env.CLAUDE_SMALL_MODEL || "claude-v1.2";

  // TODO: Finish implementing tokenizer for more accurate model selection.
  // This currently uses _character count_, not token count.
  const model = prompt.length > 25000 ? CLAUDE_BIG : CLAUDE_SMALL;

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  // Recommended by Anthropic
  stops.push("\n\nHuman:");
  // Helps with jailbreak prompts that send fake system messages and multi-bot
  // chats that prefix bot messages with "System: Respond as <bot name>".
  stops.push("\n\nSystem:");
  // Remove duplicates
  stops = [...new Set(stops)];

  return {
    ...rest,
    model,
    prompt: prompt,
    max_tokens_to_sample: rest.max_tokens,
    stop_sequences: stops,
  };
}
