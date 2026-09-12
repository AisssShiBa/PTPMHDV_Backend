package com.ptpmhdv.userservice.service;

import com.ptpmhdv.userservice.dto.CreateUserRequest;
import com.ptpmhdv.userservice.dto.UserResponse;
import com.ptpmhdv.userservice.exception.DuplicateResourceException;
import com.ptpmhdv.userservice.exception.ResourceNotFoundException;
import com.ptpmhdv.userservice.exception.UnauthorizedException;
import com.ptpmhdv.userservice.model.KycStatus;
import com.ptpmhdv.userservice.model.User;
import com.ptpmhdv.userservice.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    @Mock
    private UserRepository userRepository;

    @InjectMocks
    private UserServiceImpl userService;

    @Test
    void createUser_Success() {
        CreateUserRequest request = new CreateUserRequest();
        request.setAuthUserId("auth-123");
        request.setEmail("test@example.com");

        when(userRepository.existsByAuthUserId("auth-123")).thenReturn(false);
        when(userRepository.existsByEmail("test@example.com")).thenReturn(false);
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User u = invocation.getArgument(0);
            return u;
        });

        UserResponse response = userService.createUser(request, true);

        assertNotNull(response);
        assertEquals("auth-123", response.getAuthUserId());
        assertEquals("test@example.com", response.getEmail());
        assertEquals(KycStatus.NONE, response.getKycStatus());
        verify(userRepository, times(1)).save(any(User.class));
    }

    @Test
    void createUser_UnauthorizedWhenNotInternalCall() {
        CreateUserRequest request = new CreateUserRequest();
        request.setAuthUserId("auth-123");
        request.setEmail("test@example.com");

        assertThrows(UnauthorizedException.class, () -> userService.createUser(request, false));
    }

    @Test
    void createUser_DuplicateAuthUserId() {
        CreateUserRequest request = new CreateUserRequest();
        request.setAuthUserId("auth-123");
        request.setEmail("test@example.com");

        when(userRepository.existsByAuthUserId("auth-123")).thenReturn(true);

        assertThrows(DuplicateResourceException.class, () -> userService.createUser(request, true));
    }

    @Test
    void getUserById_NotFound() {
        when(userRepository.findById("non-existing-id")).thenReturn(Optional.empty());

        assertThrows(ResourceNotFoundException.class, () -> userService.getUserById("non-existing-id"));
    }
}
