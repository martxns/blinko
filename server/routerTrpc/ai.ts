import { router, authProcedure } from '../middleware';
import { z } from 'zod';
import { AiService } from '@server/aiServer';
import { prisma } from '../prisma';
import { TRPCError } from '@trpc/server';
import { CoreMessage } from '@mastra/core';
import { AiModelFactory } from '@server/aiServer/aiModelFactory';
import { RebuildEmbeddingJob } from '../jobs/rebuildEmbeddingJob';
import { getAllPathTags } from '@server/lib/helper';
import axios from 'axios';

function normalizeOllamaBaseUrl(url: string) {
  return url.replace(/\/$/, '');
}

// Ollama: Test connection
async function testOllamaConnection(baseUrl: string) {
  const endpoint = normalizeOllamaBaseUrl(baseUrl);
  const res = await axios.get(`${endpoint}/`);
  if (res.status === 200 && res.data?.version) return true;
  throw new Error('Ollama not reachable');
}

// Ollama: Fetch models/tags
async function fetchOllamaModels(baseUrl: string) {
  const endpoint = normalizeOllamaBaseUrl(baseUrl);
  const { data } = await axios.get(`${endpoint}/api/tags`);
  return data.models.map(model => ({
    label: model.name,
    value: model.name,
  }));
}

async function ollamaEmbeddings(baseUrl: string, body: any) {
  const endpoint = normalizeOllamaBaseUrl(baseUrl);
  const url = `${endpoint}/api/embeddings`;
  const res = await axios.post(url, body);
  return res.data;
}

export const aiRouter = router({
  embeddingUpsert: authProcedure
    .input(z.object({
      id: z.number(),
      content: z.string(),
      type: z.enum(['update', 'insert'])
    }))
    .mutation(async ({ input }) => {
      const { id, content, type } = input
      const createTime = await prisma.notes.findUnique({ where: { id } }).then(i => i?.createdAt)
      const { ok, error } = await AiService.embeddingUpsert({ id, content, type, createTime: createTime! })
      if (!ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error
        })
      }
      return { ok }
    }),

  embeddingInsertAttachments: authProcedure
    .input(z.object({
      id: z.number(),
      filePath: z.string() //api/file/text.pdf
    }))
    .mutation(async ({ input }) => {
      const { id, filePath } = input
      try {
        const res = await AiService.embeddingInsertAttachments({ id, filePath })
        return res
      } catch (error) {
        return { ok: false, msg: error?.message }
      }
    }),

  embeddingDelete: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .mutation(async ({ input }) => {
      const { id } = input
      try {
        const res = await AiService.embeddingDelete({ id })
        return res
      } catch (error) {
        return { ok: false, msg: error?.message }
      }
    }),

  completions: authProcedure
    .input(z.object({
      question: z.string(),
      withTools: z.boolean().optional(),
      withOnline: z.boolean().optional(),
      withRAG: z.boolean().optional(),
      conversations: z.array(z.object({ role: z.string(), content: z.string() })),
      systemPrompt: z.string().optional()
    }))
    .mutation(async function* ({ input, ctx }) {
      try {
        const { question, conversations, withTools = false, withOnline = false, withRAG = true, systemPrompt } = input
        let _conversations = conversations as CoreMessage[]
        const { result: responseStream, notes } = await AiService.completions({
          question,
          conversations: _conversations,
          ctx,
          withTools,
          withOnline,
          withRAG,
          systemPrompt
        })
        for await (const chunk of responseStream.fullStream) {
          yield { chunk }
        }
        yield { notes }
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message
        })
      }
    }),

  speechToText: authProcedure
    .input(z.object({
      filePath: z.string()
    }))
    .mutation(async function ({ input }) {
      // const { filePath } = input
      // try {
      //   const localFilePath = await FileService.getFile(filePath)
      //   const doc = await AiService.speechToText(localFilePath)
      //   return doc
      // } catch (error) {
      //   throw new Error(error)
      // }
    }),

  rebuildingEmbeddings: authProcedure
    .input(z.object({
      force: z.boolean().optional()
    }))
    .mutation(async function* ({ input }) {
      const { force } = input
      try {
        for await (const result of AiService.rebuildEmbeddingIndex({ force })) {
          yield result;
        }
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error?.message
        })
      }
    }),

  summarizeConversationTitle: authProcedure
    .input(z.object({
      conversations: z.array(z.object({ role: z.string(), content: z.string() })),
      conversationId: z.number()
    }))
    .mutation(async function ({ input }) {
      const { conversations, conversationId } = input
      const agent = await AiModelFactory.SummarizeAgent()
      const conversationString = JSON.stringify(
        conversations.map(i => ({
          role: i.role,
          content: i.content.replace(/\n/g, '\\n')
        })),
        null, 2
      );
      const result = await agent.generate(conversationString)
      const conversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: { title: result?.text }
      })
      return conversation
    }),

  writing: authProcedure
    .input(z.object({
      question: z.string(),
      type: z.enum(['expand', 'polish', 'custom']).optional(),
      content: z.string().optional()
    }))
    .mutation(async function* ({ input }) {
      const { question, type = 'custom', content } = input
      const agent = await AiModelFactory.WritingAgent(type)
      const result = await agent.stream([
        {
          role: 'user',
          content: question
        },
        {
          role: 'system',
          content: `This is the user's note content: ${content || ''}`
        }
      ]);
      for await (const chunk of result.fullStream) {
        yield chunk
      }
    }),
  autoTag: authProcedure
    .input(z.object({
      content: z.string()
    }))
    .mutation(async function ({ input }) {
      const config = await AiModelFactory.globalConfig();
      const { content } = input
      const tagAgent = await AiModelFactory.TagAgent(config.aiTagsPrompt || undefined);
      const tags = await getAllPathTags();
      const result = await tagAgent.generate(
        `Existing tags list: [${tags.join(', ')}]\nNote content: ${content}\nPlease suggest appropriate tags for this content. Include full hierarchical paths for tags like #Parent/Child instead of just #Child.`
      )
      return result?.text?.trim().split(',').map(tag => tag.trim()).filter(Boolean) ?? []
    }),
  autoEmoji: authProcedure
    .input(z.object({
      content: z.string()
    }))
    .mutation(async function ({ input }) {
      const { content } = input
      const agent = await AiModelFactory.EmojiAgent()
      const result = await agent.generate("Please select and suggest appropriate emojis for the above content" + content)
      console.log(result.text)
      return result?.text?.trim().split(',').map(tag => tag.trim()).filter(Boolean) ?? [];
    }),
  AIComment: authProcedure
    .input(z.object({
      content: z.string(),
      noteId: z.number()
    }))
    .mutation(async function ({ input }) {
      return await AiService.AIComment(input)
    }),

  rebuildEmbeddingStart: authProcedure
    .input(z.object({
      force: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      await RebuildEmbeddingJob.ForceRebuild(input.force ?? true);
      return { success: true };
    }),

  rebuildEmbeddingStop: authProcedure
    .mutation(async () => {
      await RebuildEmbeddingJob.StopRebuild();
      return { success: true };
    }),

  rebuildEmbeddingProgress: authProcedure
    .query(async () => {
      const progress = await RebuildEmbeddingJob.GetProgress();
      return progress || {
        current: 0,
        total: 0,
        percentage: 0,
        isRunning: false,
        results: [],
        lastUpdate: new Date().toISOString()
      };
    }),

  testConnect: authProcedure
    .input(z.object({
      aiApiEndpoint: z.string(),
      provider: z.string(),
    }))
    .mutation(async ({ input }) => {
      if (input.provider === 'Ollama') {
        await testOllamaConnection(input.aiApiEndpoint);
        return { success: true };
      }
      // ...other providers...
    }),

  fetchModels: authProcedure
    .input(z.object({
      provider: z.string(),
      aiApiEndpoint: z.string(),
      aiApiKey: z.string().optional(),
      embeddingApiEndpoint: z.string().optional(),
      embeddingApiKey: z.string().optional(),
      rerankUseEembbingEndpoint: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      let aiModels = [];
      let embeddingModels = [];
      let rerankModels = [];

      if (input.provider === 'Ollama') {
        aiModels = await fetchOllamaModels(input.aiApiEndpoint);
        embeddingModels = aiModels;
        rerankModels = aiModels;
      } else {
        // Example: OpenAI or others
        const endpoint = input.aiApiEndpoint || 'https://api.openai.com';
        const { data } = await axios.get(`${endpoint}/models`, {
          headers: { 'Authorization': `Bearer ${input.aiApiKey}` }
        });
        aiModels = data.data.map(model => ({
          label: model.id,
          value: model.id,
        }));
        embeddingModels = aiModels;
        rerankModels = aiModels;

        // If embedding endpoint is set, fetch embedding models (for OpenAI-like APIs)
        if (input.embeddingApiEndpoint) {
          const { data } = await axios.get(`${input.embeddingApiEndpoint}/models`, {
            headers: { 'Authorization': `Bearer ${input.embeddingApiKey}` }
          });
          embeddingModels = data.data.map(model => ({
            label: model.id,
            value: model.id,
          }));
          if (input.rerankUseEembbingEndpoint) {
            rerankModels = embeddingModels;
          }
        }
      }

      return { aiModels, embeddingModels, rerankModels };
    }),
})
