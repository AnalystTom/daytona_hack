export const NICRRON_URL = "https://api.nicrron.ai/v1/chat/completions";

// A Nicrron chat completion whose message content is `content`.
export const chatReply = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });
