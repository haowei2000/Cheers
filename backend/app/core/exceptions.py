"""统一异常体系."""


class AppError(Exception):
    """所有业务异常的基类."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(self, message: str = "internal server error") -> None:
        super().__init__(message)
        self.message = message


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"

    def __init__(self, message: str = "resource not found") -> None:
        super().__init__(message)


class ForbiddenError(AppError):
    status_code = 403
    code = "forbidden"

    def __init__(self, message: str = "forbidden") -> None:
        super().__init__(message)


class BadRequestError(AppError):
    status_code = 400
    code = "bad_request"

    def __init__(self, message: str = "bad request") -> None:
        super().__init__(message)


class ConflictError(AppError):
    status_code = 409
    code = "conflict"

    def __init__(self, message: str = "conflict") -> None:
        super().__init__(message)


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"

    def __init__(self, message: str = "unauthorized") -> None:
        super().__init__(message)
