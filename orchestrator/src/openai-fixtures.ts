export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

// An OpenAI chat completion whose message content is `content`.
export const chatReply = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });
