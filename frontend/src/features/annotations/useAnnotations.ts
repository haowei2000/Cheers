import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAnnotation,
  deleteAnnotation,
  editAnnotation,
  listAnnotations,
  type AnnotationInput,
  type SavedAnnotation,
} from "@/api/annotations";
export const annotationKey = (channel: string) =>
  ["annotations", channel] as const;
export function useChannelAnnotations(channel: string) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: annotationKey(channel),
    queryFn: () => listAnnotations(channel),
    enabled: Boolean(channel),
    refetchInterval: 15000,
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: annotationKey(channel) });
  const add = useMutation({
    mutationFn: (input: AnnotationInput) => createAnnotation(channel, input),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ item, note }: { item: SavedAnnotation; note: string }) =>
      editAnnotation(channel, item, note),
    onSuccess: refresh,
    onError: refresh,
  });
  const remove = useMutation({
    mutationFn: (item: SavedAnnotation) => deleteAnnotation(channel, item),
    onSuccess: refresh,
    onError: refresh,
  });
  return {
    ...query,
    notes: query.data?.notes ?? [],
    importWarning: query.data?.import_warning,
    add: add.mutateAsync,
    edit: edit.mutateAsync,
    remove: remove.mutateAsync,
    pending: add.isPending || edit.isPending || remove.isPending,
  };
}
