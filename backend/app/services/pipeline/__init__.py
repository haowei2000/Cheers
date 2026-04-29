"""Message-push pipeline abstractions: events, EventBus, Stages, RunContext.

This package is the home of the pipeline-v2 refactor. Today it exports the
typed event variants and EventBus implementations; later phases add Stage
ABCs, IngestPipeline, BotPipeline, and the dispatch_sub_agent helper.
"""
