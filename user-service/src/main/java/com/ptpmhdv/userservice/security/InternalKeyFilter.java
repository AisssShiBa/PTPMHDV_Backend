package com.ptpmhdv.userservice.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.ptpmhdv.userservice.dto.ApiResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Slf4j
@Component
public class InternalKeyFilter extends OncePerRequestFilter {

    @Value("${app.internal-key}")
    private String configuredInternalKey;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AntPathMatcher pathMatcher = new AntPathMatcher();

    // Internal paths requiring valid X-Internal-Key header
    private static final List<String> STRICT_INTERNAL_PATHS = List.of(
            "/api/users/*/kyc-status"
    );

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String internalKeyHeader = request.getHeader("X-Internal-Key");
        boolean isValidInternalKey = internalKeyHeader != null && internalKeyHeader.equals(configuredInternalKey);

        request.setAttribute("isInternalCall", isValidInternalKey);

        String path = request.getRequestURI();
        String method = request.getMethod();

        // Check if POST /api/users is internal
        boolean isCreateUserCall = "POST".equalsIgnoreCase(method) && "/api/users".equals(path);
        boolean isStrictInternalPath = STRICT_INTERNAL_PATHS.stream().anyMatch(p -> pathMatcher.match(p, path));

        if ((isCreateUserCall || isStrictInternalPath) && !isValidInternalKey) {
            log.warn("Unauthorized internal call attempt to path: {}", path);
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType(MediaType.APPLICATION_JSON_VALUE);
            ApiResponse<Void> apiResponse = ApiResponse.error("UNAUTHORIZED", "Missing or invalid X-Internal-Key header");
            objectMapper.writeValue(response.getWriter(), apiResponse);
            return;
        }

        filterChain.doFilter(request, response);
    }
}
