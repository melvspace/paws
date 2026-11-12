export interface TextGenerationInput {
  readonly model: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
}
